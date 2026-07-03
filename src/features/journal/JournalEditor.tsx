/**
 * JournalEditor — distraction-free writing with Lexical.
 *
 * Plain text editor. No toolbar. Autosave with 1500ms debounce.
 * Mood selector + tag management preserved exactly.
 * Entry content stored as plain text (via $getRoot().getTextContent()).
 *
 * AI panel sits below the date header — visible only after the entry is saved.
 * Writing experience is completely unchanged; AI is an explicit user action.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { $getRoot, $createParagraphNode, $createTextNode, type EditorState } from 'lexical';
import { useEntryByDate, useUpsertEntry } from './hooks';
import { useSettings } from '../settings/hooks';
import { useEntryInsight, useGenerateInsight, formatReflectedAt } from '../insights/hooks';
import type { EntryUpsertPayload, Mood } from '../../entities/entry';
import { MOODS } from '../../entities/entry';
import { isSentimentPayload } from '../../entities/insight';
import type { AiAction } from '../../entities/insight';
import { ServiceError } from '../../services/errors';
import { AUTOSAVE_DEBOUNCE_MS, MOOD_EMOJIS } from '../../shared/constants';
import { formatDisplayDate, getTodayLocal } from '../../shared/utils/dates';

// ─── Sentiment emoji map ───────────────────────────────────

const SENTIMENT_EMOJI: Record<string, string> = {
  positive: '😊',
  neutral: '😐',
  negative: '😔',
};

// ─── AiMenu — extensible AI action popover ─────────────────

interface AiMenuProps {
  actions: AiAction[];
  isOpen: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

function AiMenu({ actions, isOpen, onClose, triggerRef }: AiMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const hasDisabled = actions.some((a) => !a.enabled);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen, onClose, triggerRef]);

  if (!isOpen) return null;

  return (
    <div className="ai-menu-popover" ref={menuRef} role="menu">
      {actions.map((action) => (
        <button
          key={action.id}
          className="ai-menu-item"
          role="menuitem"
          disabled={!action.enabled}
          onClick={() => {
            if (action.enabled) {
              action.invoke();
            }
          }}
          type="button"
        >
          <span>✦ {action.label}</span>
          {!action.enabled && action.disabledReason && (
            <span className="ai-menu-item-reason">{action.disabledReason}</span>
          )}
        </button>
      ))}
      {hasDisabled && (
        <div className="ai-menu-footer">More AI features coming soon</div>
      )}
    </div>
  );
}

// ─── InitPlugin — loads existing content into the editor ──────

interface InitPluginProps {
  initialContent: string;
  onReady: () => void;
}

function InitPlugin({ initialContent, onReady }: InitPluginProps) {
  const [editor] = useLexicalComposerContext();
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    editor.update(() => {
      const root = $getRoot();
      root.clear();
      if (initialContent) {
        // Split by newlines to preserve paragraph breaks
        const lines = initialContent.split('\n');
        lines.forEach((line, i) => {
          const para = $createParagraphNode();
          para.append($createTextNode(line));
          if (i === 0) {
            root.append(para);
          } else {
            root.append(para);
          }
        });
      } else {
        const para = $createParagraphNode();
        root.append(para);
      }
    });

    onReady();
  }, [editor, initialContent, onReady]);

  return null;
}

// ─── Main component ───────────────────────────────────────────

interface JournalEditorProps {
  date: string; // "YYYY-MM-DD"
}

const editorTheme = {
  paragraph: 'journal-textarea-para',
};

export function JournalEditor({ date }: JournalEditorProps) {
  const navigate = useNavigate();
  const { data: existingEntry, isLoading, error } = useEntryByDate(date);
  const upsertMutation = useUpsertEntry();
  const { data: settings } = useSettings();

  const [mood, setMood] = useState<Mood | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  // AI menu state
  const [menuOpen, setMenuOpen] = useState(false);
  const reflectBtnRef = useRef<HTMLButtonElement>(null);

  // ── Editor initialization ──────────────────────────────────
  //
  // The LexicalComposer must NOT mount until we know the initial content.
  // If it mounts while existingEntry is still loading, InitPlugin runs with
  // initialContent='' and marks the editor ready — then when the fetch resolves
  // the seeding effect is skipped because isEditorReadyRef is already true,
  // leaving the editor permanently blank.
  //
  // Fix: gate the LexicalComposer on `editorSeedReady` — a boolean that only
  // becomes true after useEntryByDate resolves (either null or Entry).
  // This guarantees InitPlugin always receives the correct content on first run.
  const isEditorReadyRef = useRef(false);
  const [editorSeedReady, setEditorSeedReady] = useState(false);
  const [initialContent, setInitialContent] = useState('');

  // lastSavedContent — last successfully saved content string.
  // Used by useEntryInsight for stale detection (not live keystrokes).
  // Kept as state so the value can be read during render by the hook.
  // A companion ref mirrors it for synchronous reads inside saveEntry().
  const [lastSavedContent, setLastSavedContent] = useState('');
  const lastSavedContentRef = useRef('');

  // Latest mood/tags as refs — kept in sync via effect so the debounced
  // save closure always reads the current value without stale captures.
  const moodRef = useRef<Mood | null>(mood);
  const tagsRef = useRef<string[]>(tags);

  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

  useEffect(() => {
    tagsRef.current = tags;
  }, [tags]);

  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // NOTE: All state resets on date change are handled for free by `key={date}` on
  // LexicalComposer below — React unmounts and remounts the entire subtree.

  // Seed editor once the fetch resolves.
  //
  // We wait until isLoading=false to avoid the race where InitPlugin initialises
  // with '' before the entry arrives.  The key invariant is:
  //
  //   editorSeedReady = true  ⟺  initialContent already reflects the DB value
  //
  // After seeding we never touch initialContent again — subsequent edits flow
  // through the autosave path, not the seed path.
  //
  // All setState calls are deferred via setTimeout to satisfy the
  // react-hooks/set-state-in-effect lint rule while keeping them batched.
  useEffect(() => {
    if (isLoading) return;       // still fetching — wait
    if (editorSeedReady) return; // already seeded — nothing to do

    // Snapshot the entry synchronously before the timeout closure captures it,
    // so it is not affected by any future React Query re-fetches.
    const content = existingEntry?.content ?? '';
    const mood = existingEntry?.mood ?? null;
    const tags = existingEntry?.tags ?? [];

    // Update the ref synchronously so autosave can read the right content
    // even if a mood/tag change fires before the timeout.
    lastSavedContentRef.current = content;

    const t = setTimeout(() => {
      setMood(mood);
      setTags(tags);
      setInitialContent(content);
      setLastSavedContent(content);
      // Signal the LexicalComposer to mount with the correct content.
      setEditorSeedReady(true);
    }, 0);
    return () => clearTimeout(t);
  }, [isLoading, existingEntry, editorSeedReady]);

  const handleEditorReady = useCallback(() => {
    isEditorReadyRef.current = true;
  }, []);

  const saveEntry = useCallback(
    async (content: string) => {
      const payload: EntryUpsertPayload = {
        entryDate: date,
        content,
        mood: moodRef.current,
        tags: tagsRef.current,
      };
      setIsSaving(true);
      try {
        await upsertMutation.mutateAsync(payload);
        setLastSaved(new Date());
        // Update both ref (for sync reads) and state (for render/hooks) after save.
        lastSavedContentRef.current = content;
        setLastSavedContent(content);
      } catch {
        // Error handled by React Query
      } finally {
        setIsSaving(false);
      }
    },
    [date, upsertMutation],
  );

  const handleEditorChange = useCallback(
    (editorState: EditorState) => {
      if (!isEditorReadyRef.current) return;

      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);

      autosaveTimerRef.current = setTimeout(() => {
        editorState.read(() => {
          const text = $getRoot().getTextContent();
          saveEntry(text);
        });
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [saveEntry],
  );

  // Re-trigger save when mood or tags change (without waiting for editor change).
  // Use lastSavedContentRef so we always save the current editor content —
  // not existingEntry.content, which could be stale after in-session edits.
  const moodTagsSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!isEditorReadyRef.current) return;
    if (moodTagsSaveTimer.current) clearTimeout(moodTagsSaveTimer.current);
    moodTagsSaveTimer.current = setTimeout(() => {
      saveEntry(lastSavedContentRef.current);
    }, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mood, tags]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      if (moodTagsSaveTimer.current) clearTimeout(moodTagsSaveTimer.current);
    };
  }, []);

  // AI state — derived from saved entry + hooks.
  // Pass lastSavedContent (state) — not lastSavedContentRef.current (ref) — so
  // the hook sees the updated value after each successful save.
  const { insight, isStale } = useEntryInsight(
    existingEntry?.id,
    lastSavedContent,
  );
  const generateMutation = useGenerateInsight();

  // Auto-clear generate error after 5s.
  // MODEL_LOADING errors get a distinct, user-actionable message with a longer
  // display time (10s) since the user needs time to read the retry suggestion.
  // setState is called inside setTimeout to satisfy react-hooks/set-state-in-effect.
  const [generateError, setGenerateError] = useState('');
  const [isModelLoading, setIsModelLoading] = useState(false);
  useEffect(() => {
    if (!generateMutation.isError) return;

    const err = generateMutation.error;
    const isLoading =
      err instanceof ServiceError && err.code === 'MODEL_LOADING';
    const msg = isLoading
      ? (err as ServiceError).message
      : err instanceof Error
        ? err.message
        : 'Reflection failed. Please try again.';

    const displayMs = isLoading ? 10_000 : 5_000;
    const setT = setTimeout(() => {
      setGenerateError(msg);
      setIsModelLoading(isLoading);
    }, 0);
    const clearT = setTimeout(() => {
      setGenerateError('');
      setIsModelLoading(false);
    }, displayMs);
    return () => {
      clearTimeout(setT);
      clearTimeout(clearT);
    };
  }, [generateMutation.isError, generateMutation.error]);

  // v1 AI action menu — adding a capability: new Edge Function + flip enabled: true
  const aiActions: AiAction[] = [
    {
      id: 'generate-insight',
      label: 'Generate Insight',
      description: 'Analyse the emotional tone of this entry',
      insightType: 'sentiment',
      invoke: () => {
        if (existingEntry?.id) {
          generateMutation.mutate(existingEntry.id);
        }
        setMenuOpen(false);
      },
      enabled: !generateMutation.isPending,
    },
    {
      id: 'summarize-entry',
      label: 'Summarize Entry',
      insightType: 'summary',
      invoke: () => {},
      enabled: false,
      disabledReason: 'Coming soon',
    },
    {
      id: 'reflection-prompt',
      label: 'Reflection Prompt',
      insightType: 'pattern',
      invoke: () => {},
      enabled: false,
      disabledReason: 'Coming soon',
    },
    {
      id: 'find-patterns',
      label: 'Find Patterns',
      insightType: 'pattern',
      invoke: () => {},
      enabled: false,
      disabledReason: 'Coming soon',
    },
  ];

  // Tag management
  const addTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (tag && !tags.includes(tag) && tags.length < 20) {
      setTags([...tags, tag]);
      setTagInput('');
    }
  };

  const removeTag = (tagToRemove: string) => {
    setTags(tags.filter((t) => t !== tagToRemove));
  };

  const handleTagKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    }
  };

  // Show spinner while:
  //   - data is still fetching (isLoading), OR
  //   - seed effect hasn't fired yet (editorSeedReady=false, which happens for
  //     one render cycle between isLoading→false and the seed effect running).
  // This guarantees LexicalComposer never mounts with stale/empty initialContent.
  if (isLoading || !editorSeedReady) {
    return (
      <div className="journal-editor">
        <div className="loading-spinner" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="journal-editor">
        <p className="error-message">Failed to load entry. Please try again.</p>
      </div>
    );
  }

  const isToday = date === getTodayLocal();
  const sentimentData = insight && isSentimentPayload(insight.payload) ? insight.payload : null;

  const initialConfig = {
    namespace: `journal-${date}`,
    theme: editorTheme,
    // Swallow Lexical internal errors in production — they are not user-facing
    onError: (_err: Error) => {
      if (import.meta.env.DEV) {
        console.error('Lexical editor error:', _err); // intentional dev-only log
      }
    },
  };

  return (
    <div className="journal-editor">
      {/* Header */}
      <div className="journal-editor-header">
        <h2 className="journal-date">{formatDisplayDate(date)}</h2>
        <div className="journal-meta">
          {isToday && <span className="badge badge-today">Today</span>}
          {isSaving && <span className="save-status saving">Saving…</span>}
          {!isSaving && lastSaved && (
            <span className="save-status saved">
              Saved {lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {!navigator.onLine && (
            <span className="save-status offline">Offline — will sync later</span>
          )}
        </div>
      </div>

      {/* ── AI Reflection Panel ─────────────────────────────────
          Visible only after the entry is saved (existingEntry is non-null).
          Writing, autosave, mood, and tags are completely unaffected.
      ─────────────────────────────────────────────────────── */}
      {existingEntry && (
        <div className="ai-panel">
          {/* State 2: AI not configured */}
          {!settings?.aiConfigured && (
            <p className="ai-panel-notice">
              AI Insights not enabled.{' '}
              <button
                type="button"
                className="ai-panel-link"
                onClick={() => navigate('/settings')}
              >
                Configure your AI token in Settings →
              </button>
            </p>
          )}

          {/* States 3–7: AI configured */}
          {settings?.aiConfigured && (
            <>
              {/* State 4: Reflecting in progress */}
              {generateMutation.isPending && (
                <div className="ai-panel-result">
                  <div className="loading-spinner" style={{ width: 16, height: 16 }} />
                  <span className="ai-panel-meta">Reflecting…</span>
                </div>
              )}

              {/* State 7: Error — two variants:
                  - MODEL_LOADING: amber notice with retry hint, Reflect button stays visible
                  - other errors: red notice, standard 5s auto-clear */}
              {generateError && (
                <p
                  className="ai-panel-notice"
                  style={{ color: isModelLoading ? 'var(--warning, #b45309)' : 'var(--danger)' }}
                >
                  {isModelLoading ? '⏳ ' : ''}{generateError}
                </p>
              )}

              {/* State 5 & 6: Insight exists */}
              {!generateMutation.isPending && sentimentData && (
                <div className="ai-panel-result">
                  <span
                    className={`sentiment-pill sentiment-${sentimentData.label}${isStale ? ' opacity-50' : ''}`}
                    style={isStale ? { opacity: 0.5 } : undefined}
                  >
                    {SENTIMENT_EMOJI[sentimentData.label]}{' '}
                    {sentimentData.label.charAt(0).toUpperCase() + sentimentData.label.slice(1)}
                  </span>
                  <span className="ai-panel-meta">
                    {Math.round(sentimentData.confidence * 100)}% ·{' '}
                    {formatReflectedAt(insight!.createdAt)}
                  </span>
                  {!isStale && (
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      onClick={() => navigate('/insights')}
                    >
                      View insights →
                    </button>
                  )}
                </div>
              )}

              {/* State 6 stale notice */}
              {!generateMutation.isPending && isStale && (
                <p className="ai-stale-notice">Journal updated since this insight.</p>
              )}

              {/* States 3, 5, 6: Reflect / Re-reflect menu trigger */}
              {!generateMutation.isPending && (
                <div className="ai-menu-wrapper">
                  <button
                    ref={reflectBtnRef}
                    type="button"
                    className="analyze-btn"
                    onClick={() => setMenuOpen((o) => !o)}
                  >
                    ✦ {sentimentData ? 'Re-reflect' : 'Reflect'} ▾
                  </button>
                  <AiMenu
                    actions={aiActions}
                    isOpen={menuOpen}
                    onClose={() => setMenuOpen(false)}
                    triggerRef={reflectBtnRef}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Mood */}
      <div className="mood-selector">
        <span className="mood-label">How are you feeling?</span>
        <div className="mood-options">
          {MOODS.map((m) => (
            <button
              key={m}
              className={`mood-btn${mood === m ? ' mood-active' : ''}`}
              onClick={() => setMood(mood === m ? null : m)}
              title={m}
              type="button"
            >
              <span className="mood-emoji">{MOOD_EMOJIS[m]}</span>
              <span className="mood-text">{m}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Lexical editor — only mounted after editorSeedReady=true so that
          InitPlugin always receives the correct initialContent on first run.
          key={date} ensures a full remount when the user navigates to a
          different day's entry. */}
      <div className="journal-lexical-wrapper">
        <LexicalComposer key={date} initialConfig={initialConfig}>
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                className="journal-textarea"
                aria-label="Journal entry"
                aria-multiline="true"
                spellCheck={true}
              />
            }
            placeholder={
              <div className="lexical-placeholder">
                What's on your mind today? Write freely — this is your private space.
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <AutoFocusPlugin />
          <OnChangePlugin onChange={handleEditorChange} ignoreSelectionChange />
          <InitPlugin
            initialContent={initialContent}
            onReady={handleEditorReady}
          />
        </LexicalComposer>
      </div>

      {/* Tags */}
      <div className="tags-section">
        <div className="tags-input-row">
          <input
            type="text"
            className="tag-input"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={handleTagKeyDown}
            placeholder="Add a tag…"
            maxLength={40}
            aria-label="Add tag"
          />
          <button className="btn-ghost btn-sm" onClick={addTag} type="button">
            Add
          </button>
        </div>
        {tags.length > 0 && (
          <div className="tags-list">
            {tags.map((tag) => (
              <span key={tag} className="tag">
                {tag}
                <button
                  className="tag-remove"
                  onClick={() => removeTag(tag)}
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
