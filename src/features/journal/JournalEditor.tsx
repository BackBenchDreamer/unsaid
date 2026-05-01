/**
 * JournalEditor — the core journal writing component.
 *
 * Handles:
 * - Loading existing entry for the selected date
 * - Autosave with debounce
 * - Mood selection
 * - Tag management
 * - Offline indicator integration
 *
 * All business logic is in hooks. This component only renders.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useEntryByDate, useUpsertEntry } from './hooks';
import { EntryUpsertPayload, MOODS, Mood } from '../../entities/entry';
import { AUTOSAVE_DEBOUNCE_MS, MOOD_EMOJIS } from '../../shared/constants';
import { formatDisplayDate, getTodayLocal } from '../../shared/utils/dates';

interface JournalEditorProps {
  date: string; // "YYYY-MM-DD"
}

export function JournalEditor({ date }: JournalEditorProps) {
  const { data: existingEntry, isLoading, error } = useEntryByDate(date);
  const upsertMutation = useUpsertEntry();

  const [content, setContent] = useState('');
  const [mood, setMood] = useState<Mood | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const isInitializedRef = useRef(false);

  // Initialize from existing entry.
  useEffect(() => {
    if (existingEntry && !isInitializedRef.current) {
      setContent(existingEntry.content);
      setMood(existingEntry.mood);
      setTags(existingEntry.tags);
      isInitializedRef.current = true;
    }
  }, [existingEntry]);

  // Reset when date changes.
  useEffect(() => {
    isInitializedRef.current = false;
    setContent('');
    setMood(null);
    setTags([]);
    setTagInput('');
    setLastSaved(null);
  }, [date]);

  // Autosave function.
  const saveEntry = useCallback(
    async (payload: EntryUpsertPayload) => {
      setIsSaving(true);
      try {
        await upsertMutation.mutateAsync(payload);
        setLastSaved(new Date());
      } catch {
        // Error handled by React Query.
      } finally {
        setIsSaving(false);
      }
    },
    [upsertMutation],
  );

  // Debounced autosave on content change.
  useEffect(() => {
    if (!isInitializedRef.current && !content) return;

    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
    }

    autosaveTimerRef.current = setTimeout(() => {
      saveEntry({ entryDate: date, content, mood, tags });
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
      }
    };
  }, [content, mood, tags, date, saveEntry]);

  // Tag management.
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

  if (isLoading) {
    return (
      <div className="journal-editor-loading">
        <div className="loading-spinner" />
        <p>Loading entry...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="journal-editor-error">
        <p className="error-message">Failed to load entry. Please try again.</p>
      </div>
    );
  }

  const isToday = date === getTodayLocal();

  return (
    <div className="journal-editor">
      <div className="journal-editor-header">
        <h2 className="journal-date">{formatDisplayDate(date)}</h2>
        <div className="journal-meta">
          {isToday && <span className="badge badge-today">Today</span>}
          {isSaving && <span className="save-status saving">Saving...</span>}
          {!isSaving && lastSaved && (
            <span className="save-status saved">
              Saved {lastSaved.toLocaleTimeString()}
            </span>
          )}
          {!navigator.onLine && (
            <span className="save-status offline">Offline — will sync later</span>
          )}
        </div>
      </div>

      {/* Mood selector */}
      <div className="mood-selector">
        <span className="mood-label">How are you feeling?</span>
        <div className="mood-options">
          {MOODS.map((m) => (
            <button
              key={m}
              className={`mood-btn ${mood === m ? 'mood-active' : ''}`}
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

      {/* Content editor */}
      <textarea
        className="journal-textarea"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="What's on your mind today? Write freely — this is your private space."
        autoFocus
      />

      {/* Tags */}
      <div className="tags-section">
        <div className="tags-input-row">
          <input
            type="text"
            className="tag-input"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={handleTagKeyDown}
            placeholder="Add a tag..."
            maxLength={40}
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
