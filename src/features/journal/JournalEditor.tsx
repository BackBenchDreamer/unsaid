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
import { $getRoot, $createParagraphNode, $createTextNode, type EditorState, type LexicalEditor } from 'lexical';
import { useEntryByDate, useUpsertEntry } from './hooks';
import { useSettings } from '../settings/hooks';
import { useEntryInsight, useGenerateReflection, formatReflectedAt } from '../insights/hooks';
import type { EntryUpsertPayload, Mood } from '../../entities/entry';
import { MOODS } from '../../entities/entry';
import { isSentimentPayload, isReflectionPayload } from '../../entities/insight';
import type { AiAction } from '../../entities/insight';
import { ServiceError } from '../../services/errors';
import { AUTOSAVE_DEBOUNCE_MS, MOOD_EMOJIS } from '../../shared/constants';
import { formatDisplayDate, getTodayLocal } from '../../shared/utils/dates';
import { getEmotionValence } from '../../shared/utils/emotions';

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
//
// Also captures the LexicalEditor instance into editorRef so the AI panel
// (which renders outside LexicalComposer) can call editor.update() for the
// "append question" feature. useLexicalComposerContext() can only be called
// from inside LexicalComposer, so the ref pattern is required.

interface InitPluginProps {
  initialContent: string;
  onReady: () => void;
  editorRef: React.MutableRefObject<LexicalEditor | null>;
}

function InitPlugin({ initialContent, onReady, editorRef }: InitPluginProps) {
  const [editor] = useLexicalComposerContext();
  const initialized = useRef(false);

  // Capture editor instance for external use (AI panel question append).
  useEffect(() => {
    editorRef.current = editor;
  }, [editor, editorRef]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    editor.update(() => {
      const root = $getRoot();
      root.clear();
      if (initialContent) {
        // Split by newlines to preserve paragraph breaks
        const lines = initialContent.split('\n');
        lines.forEach((line) => {
          const para = $createParagraphNode();
          para.append($createTextNode(line));
          root.append(para);
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

  // Editor ref — populated by InitPlugin so the AI panel can call editor.update()
  // from outside LexicalComposer (useLexicalComposerContext cannot be called there).
  const editorRef = useRef<LexicalEditor | null>(null);

  // ── Editor initialization ──────────────────────────────────
  const isEditorReadyRef = useRef(false);
  const [editorSeedReady, setEditorSeedReady] = useState(false);
  const [initialContent, setInitialContent] = useState('');

  // lastSavedContent — last successfully saved content string.
  // Used by useEntryInsight for stale detection (not live keystrokes).
  const [lastSavedContent, setLastSavedContent] = useState('');
  const lastSavedContentRef = useRef('');

  const moodRef = useRef<Mood | null>(mood);
  const tagsRef = useRef<string[]>(tags);

  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

  useEffect(() => {
    tagsRef.current = tags;
  }, [tags]);

  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (isLoading) return;
    if (editorSeedReady) return;

    const content = existingEntry?.content ?? '';
    const entryMood = existingEntry?.mood ?? null;
    const entryTags = existingEntry?.tags ?? [];

    lastSavedContentRef.current = content;

    const t = setTimeout(() => {
      setMood(entryMood);
      setTags(entryTags);
      setInitialContent(content);
      setLastSavedContent(content);
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

  const moodTagsSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!isEditorReadyRef.current) return;
    if (moodTagsSaveTimer.current) clearTimeout(moodTagsSaveTimer.current);
    moodTagsSaveTimer.current = setTimeout(() => {
      saveEntry(lastSavedContentRef.current);
    }, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mood, tags]);

  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      if (moodTagsSaveTimer.current) clearTimeout(moodTagsSaveTimer.current);
    };
  }, []);

  // AI state — derived from saved entry + hooks.
  const { insight, reflectionInsight, sentimentInsight, isStale } = useEntryInsight(
    existingEntry?.id,
    lastSavedContent,
  );
  const generateReflectionMutation = useGenerateReflection();

  // Append question to editor on click — uses ref pattern since AI panel
  // is outside LexicalComposer and cannot call useLexicalComposerContext().
  const appendQuestionToEditor = useCallback((question: string) => {
    editorRef.current?.update(() => {
      const root = $getRoot();
      const emptyPara = $createParagraphNode();
      root.append(emptyPara);
      const questionPara = $createParagraphNode();
      questionPara.append($createTextNode(question));
      root.append(questionPara);
    });
  }, []);

  // Auto-clear generate error after 5s (10s for MODEL_LOADING).
  const [generateError, setGenerateError] = useState('');
  const [isModelLoading, setIsModelLoading] = useState(false);
  useEffect(() => {
    if (!generateReflectionMutation.isError) return;

    const err = generateReflectionMutation.error;
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
  }, [generateReflectionMutation.isError, generateReflectionMutation.error]);

  // Derived rendering data
  const reflectionData =
    reflectionInsight && isReflectionPayload(reflectionInsight.payload)
      ? reflectionInsight.payload
      : null;
  const sentimentData =
    sentimentInsight && isSentimentPayload(sentimentInsight.payload)
      ? sentimentInsight.payload
      : null;

  // v2 AI action menu
  const aiActions: AiAction[] = [
    {
      id: 'generate-insight',
      label: 'Reflect',
      description: 'Generate a reflection on this entry',
      insightType: 'reflection',
      invoke: () => {
        if (existingEntry?.id) {
          generateReflectionMutation.mutate(existingEntry.id);
        }
        setMenuOpen(false);
      },
      enabled: !generateReflectionMutation.isPending,
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
  // insight used only for the Re-reflect button label check
  const hasAnyInsight = !!insight;

  const initialConfig = {
    namespace: `journal-${date}`,
    theme: editorTheme,
    onError: (_err: Error) => {
      if (import.meta.env.DEV) {
        console.error('Lexical editor error:', _err);
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
              {generateReflectionMutation.isPending && (
                <div className="ai-panel-result">
                  <div className="loading-spinner" style={{ width: 16, height: 16 }} />
                  <span className="ai-panel-meta">Reflecting…</span>
                </div>
              )}

              {/* State 7: Error */}
              {generateError && (
                <p
                  className="ai-panel-notice"
                  style={{ color: isModelLoading ? 'var(--warning, #b45309)' : 'var(--danger)' }}
                >
                  {isModelLoading ? '⏳ ' : ''}{generateError}
                </p>
              )}

              {/* State 5 & 6: Insight exists */}
              {!generateReflectionMutation.isPending && (reflectionData || sentimentData) && (
                <>
                  {reflectionData ? (
                    /* ── State 5: Full reflection card ── */
                    <div
                      className="reflection-card"
                      style={isStale ? { opacity: 0.5 } : undefined}
                    >
                      <div className="reflection-header">
                        <span className="reflection-header-label">Reflection</span>
                        <span className="reflection-header-time">
                          {formatReflectedAt(reflectionInsight!.createdAt)}
                        </span>
                      </div>
                      <p className="reflection-summary">{reflectionData.summary}</p>
                      <div className="reflection-emotions">
                        {reflectionData.emotions.map((e) => {
                            const label =
                              e.label.charAt(0).toUpperCase() +
                              e.label.slice(1).toLowerCase();
                            return (
                              <span
                                key={e.label}
                                className={`reflection-emotion-pill ${getEmotionValence(e.label)}`}
                              >
                                ● {label} {Math.round(e.score * 100)}%
                              </span>
                            );
                          })}
                      </div>
                      {reflectionData.themes.length > 0 && (
                        <p className="reflection-themes">
                          {reflectionData.themes.join(' · ')}
                        </p>
                      )}
                      <div className="reflection-divider" />
                      <div className="reflection-question-wrapper">
                        <p
                          className="reflection-question"
                          onClick={() => appendQuestionToEditor(reflectionData.question)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              appendQuestionToEditor(reflectionData.question);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          title="Tap to add this question to your entry"
                        >
                          {reflectionData.question}
                        </p>
                        <span className="reflection-question-hint">↵ Add to entry</span>
                      </div>
                    </div>
                  ) : sentimentData ? (
                    /* ── State 5 fallback: legacy sentiment pill ── */
                    <>
                      <div className="ai-panel-result">
                        <span
                          className={`sentiment-pill sentiment-${sentimentData.label}`}
                          style={isStale ? { opacity: 0.5 } : undefined}
                        >
                          {SENTIMENT_EMOJI[sentimentData.label]}{' '}
                          {sentimentData.label.charAt(0).toUpperCase() + sentimentData.label.slice(1)}
                        </span>
                        <span className="ai-panel-meta">
                          {Math.round(sentimentData.confidence * 100)}% ·{' '}
                          {formatReflectedAt(sentimentInsight!.createdAt)}
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
                      {/* "Configure Groq" nudge — hidden when stale to reduce noise */}
                      {!settings?.reflectionConfigured && !isStale && (
                        <p className="reflection-richer-notice">
                          Richer reflections available —{' '}
                          <button
                            type="button"
                            className="ai-panel-link"
                            onClick={() => navigate('/settings')}
                          >
                            configure Groq in Settings
                          </button>
                          .
                        </p>
                      )}
                    </>
                  ) : null}

                  {/* State 6: Stale notice */}
                  {isStale && (
                    <p className="ai-stale-notice">Journal updated since this insight.</p>
                  )}

                  {/* "View insights" link under reflection card (fresh only) */}
                  {reflectionData && !isStale && (
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      style={{ marginTop: 'var(--space-xs)' }}
                      onClick={() => navigate('/insights')}
                    >
                      View insights →
                    </button>
                  )}
                </>
              )}

              {/* States 3, 5, 6: Reflect / Re-reflect menu trigger */}
              {!generateReflectionMutation.isPending && (
                <div className="ai-menu-wrapper">
                  <button
                    ref={reflectBtnRef}
                    type="button"
                    className="analyze-btn"
                    onClick={() => setMenuOpen((o) => !o)}
                  >
                    ✦ {hasAnyInsight ? 'Re-reflect' : 'Reflect'} ▾
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

      {/* Lexical editor */}
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
            editorRef={editorRef}
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
