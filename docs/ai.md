# AI Pipeline

> How reflection works, how memory is built, and the design principles behind both.

## Table of Contents

- [Philosophy](#philosophy)
- [Reflection Hierarchy](#reflection-hierarchy)
- [Per-Entry Reflection](#per-entry-reflection)
- [Weekly Reflection](#weekly-reflection)
- [Memory System](#memory-system)
- [Context Injection](#context-injection)
- [Prompt Versioning](#prompt-versioning)
- [Token Setup](#token-setup)
- [Error Codes](#error-codes)

---

## Philosophy

Three principles govern every AI feature in UnSaid:

1. **Writing is the primary experience.** AI never runs automatically. Autosave is persistence, not analysis.
2. **Reflection is an explicit choice.** The user decides when they are ready. Nothing infers without permission.
3. **Memory exists before intelligence.** The system builds a reliable memory of a person's life first. Only then does it draw conclusions.

AI should feel like a thoughtful companion, not a background process watching everything you type.

---

## Reflection Hierarchy

Each level of reflection builds on the level below it, preferring existing work over reprocessing raw entries.

```
Journal Entry
      ↓
Per-entry Reflection   — type='reflection', entry_id=UUID
      ↓
Weekly Reflection      — type='summary',    entry_id=NULL, period_start/end
      ↓
Monthly Reflection     — (future)
      ↓
Year in Reflection     — (future)
```

A weekly reflection reads the week's per-entry reflection summaries — not the raw entries. This keeps inference costs proportional to what is new, and produces richer output because it synthesises already-interpreted material.

Each level falls back gracefully when lower-level work is absent: a weekly reflection without per-entry reflections uses raw entry excerpts as a substitute.

---

## Per-Entry Reflection

<!-- TODO: Screenshot of the reflection panel in the journal editor -->
<!-- docs/images/reflection-panel.png -->

**Providers:** HuggingFace (emotion classification) + Groq (LLM reflection)

**Flow (`generate-reflection` Edge Function):**

1. Validate JWT; assert entry ownership
2. Fetch existing insight row (for cache check later)
3. Call HF emotion model → 7 emotion probability scores
4. Extract top-3 emotion labels as relevance seeds
5. Query `context_memory` + `life_chapters`; build context block (≤ 500 tokens)
6. Compute `source_hash` including `contextHash` when context is non-empty
7. Cache check: if `source_hash` matches stored row → return cached
8. Call Groq LLM with emotion scores + entry excerpt + context block
9. Validate JSON response shape
10. Upsert to `insights` with `source_hash`
11. Fire-and-forget `extract-memory` (no client wait)
12. Return `{ result, meta: { cached, generationMs } }`

**`ReflectionPayload` schema:**

```json
{
  "summary": "2–3 sentence reflection addressed to the person.",
  "emotions": [
    { "label": "Joy",     "score": 0.42 },
    { "label": "Neutral", "score": 0.30 },
    { "label": "Sadness", "score": 0.11 },
    { "label": "Fear",    "score": 0.06 }
  ],
  "themes": ["Work", "Family"],
  "question": "One open-ended follow-up question?",
  "_meta": {
    "version": "3.0.0",
    "provider": "groq",
    "model": "llama-3.1-8b-instant",
    "generatedAt": "2026-07-10T12:00:00.000Z",
    "generationMs": 3200
  }
}
```

**Staleness detection:**  
The `source_hash` is a SHA-256 of `{ content, promptVersion, model, contextHash? }`. If the entry content changes, the promptVersion bumps, or the memory context changes significantly, the stored hash no longer matches → the client shows "Re-reflect" and the old result is regenerated on next click.

**HuggingFace endpoint (important):**
```
Current:  https://router.huggingface.co/hf-inference/models/<model>
Retired:  https://api-inference.huggingface.co/models/<model>  ← NXDOMAIN as of 2026
```

---

## Weekly Reflection

**Provider:** Groq only

**Trigger:** User navigates to `/insights`. If ≥ `WEEKLY_REFLECTION_MIN_ENTRIES` entries exist for the current week and no cached weekly reflection exists, an invitation card appears.

**Flow (`generate-weekly-summary` Edge Function):**

1. Validate JWT; parse `weekStart` (must be a Monday in `"YYYY-MM-DD"` format)
2. Fetch all entries for the week
3. Guard: 0 entries → `INSUFFICIENT_ENTRIES` (422)
4. Build `entryHashes[]` — use per-entry `source_hash` for reflected entries; compute a hash of raw content for unreflected entries
5. Compute `weeklySourceHash` — includes week boundaries, prompt version, model, and entry hashes
6. Cache check: if stored hash matches → return cached
7. Call Groq with synthesis prompt + per-entry summaries (or raw excerpts)
8. Upsert to `insights` with `entry_id=NULL`, `period_start`, `period_end`

**`WeeklyPayload` schema:**

```json
{
  "narrative": "This week began with uncertainty but gradually shifted toward a quieter focus.",
  "dominantEmotions": [
    { "label": "Joy",     "score": 0.38 },
    { "label": "Neutral", "score": 0.32 }
  ],
  "recurringThemes": ["Work", "Rest"],
  "emotionalArc": "from uncertainty toward quiet focus",
  "_meta": {
    "version": "1.0.0",
    "provider": "groq",
    "model": "llama-3.1-8b-instant",
    "generatedAt": "2026-07-14T09:00:00.000Z",
    "generationMs": 2800
  }
}
```

---

## Memory System

<!-- TODO: Memory architecture diagram showing extraction pipeline and injection point -->
<!-- docs/images/memory-architecture.png -->

The memory system extracts two types of information from reflected journal entries:

### Context Memory (`context_memory` table)

Recurring entities: people, places, projects, organisations, and topics. Used internally to enrich future reflection prompts. Users do not see this data directly in M3 — it powers the context injection step silently.

Each entity has:
- `entity_type` — `person | place | project | organization | topic`
- `entity_value` — lowercase normalized (e.g. `"ashu"`, `"ibm"`)
- `mention_count` — incremented on each appearance (append-only)
- `emotional_tags` — emotions co-occurring with this entity (grows over time)
- `last_seen_date` — `entry_date` of the most recent mention
- `importance_score` — `NULL` in M3; reserved for future relevance ranking

### Life Chapters (`life_chapters` table)

Meaningful collections of related journal entries representing distinct life episodes (e.g. "IBM Internship", "Thailand Trip"). Discovered automatically by the extraction pipeline.

**Chapter lifecycle:**
```
forming  →  active  →  dormant
```

- `forming`: candidate detected; not yet structurally stable
- `active`: promoted; LLM-named; stable evidence
- `dormant`: no new entries for `CHAPTER_DORMANCY_DAYS` (60 days)

**Chapter promotion gates (all three must pass):**
1. `entry_count ≥ CHAPTER_MIN_ENTRIES` (3)
2. No new entries for `CHAPTER_STABILITY_DAYS` (7 days)
3. Theme drift ≤ 50% (Jaccard overlap of original vs current themes ≥ 0.5)

**Multi-signal chapter candidate scoring:**

A cluster of entries qualifies as a chapter candidate when:
- They are within `CHAPTER_CANDIDATE_WINDOW_DAYS` (90 days) of each other — based on `entry_date`, not `created_at`
- ≥ 2 of the following signals pass:
  - Signal (a): entity co-occurrence (shared people, places, projects, orgs)
  - Signal (c): theme overlap (shared topics from `ReflectionPayload.themes`)

### Extraction Pipeline (`extract-memory` Edge Function)

Runs fire-and-forget after every successful reflection. The user never waits for it.

**Idempotency guarantee:**  
`memory_extractions` table is the commit point. The extraction record is written as the final step. If anything above fails, no record exists → the next call retries the full pipeline from scratch.

**Retry safety:**  
Entity increments use `last_seen_date` as a natural idempotency key. If `existing.last_seen_date === entryDate`, the increment was already applied for this entry → skip.

**Two independent version fields on `memory_extractions`:**
- `prompt_version` — the reflection's `_meta.version` at extraction time
- `extraction_version` — the `EXTRACTION_VERSION` constant in the Edge Function

Bump `prompt_version` (via `AI_CONFIG`) when reflection output changes structurally. Bump `EXTRACTION_VERSION` when the extraction pipeline itself changes. Never bump both for the same change.

---

## Context Injection

When `generate-reflection` runs, it queries the memory system before calling Groq:

1. After HF emotion scores are available, extract the top-3 emotion labels as theme seeds
2. Fetch `context_memory` entities with `mention_count ≥ CONTEXT_MEMORY_MIN_MENTIONS` (3)
3. Score each entity by relevance to the theme seeds (+2 for entity_value overlap, +1 for emotional_tags overlap)
4. Filter to `score > 0`; sort by score then mention_count
5. Fetch active named life chapters; score by theme_tags overlap
6. Assemble a context block within `CONTEXT_MEMORY_MAX_TOKENS` (500 tokens ≈ 2000 chars)
7. Inject into the Groq system prompt under `Context about this person:`
8. Include a `contextHash` in `source_hash` so memory changes invalidate the reflection cache

If context is empty (no memory yet), the prompt is identical to the pre-memory version — zero regression.

---

## Prompt Versioning

`AI_CONFIG.promptVersion` in `src/entities/insight.ts` and the `AI_CONFIG` mirror in `generate-reflection/index.ts` must be kept in sync.

| Version | Milestone | Change |
|---|---|---|
| `1.0.0` | M1 | Initial reflection prompt |
| `2.0.0` | M1 | Voice fix (second-person enforcement) |
| `2.1.0` | M2 | Minor voice refinement |
| `3.0.0` | M3 | Context injection added |

**Bumping rules:**
- Only bump when the reflection *output* is structurally different (new fields, different voice, context injection)
- Never bump for wording tweaks
- A bump stales all existing cached reflections → users see "Re-reflect" on next visit (intentional)
- Weekly reflection has its own independent version (`_meta.version = "1.0.0"`) — bumping per-entry version never invalidates weekly caches

---

## Token Setup

Go to **Settings → AI Configuration** in the app.

**Emotion Analysis (HuggingFace):**
1. Create a read token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
2. Paste it in Settings → Save — encrypted immediately; never stored or displayed in plaintext

**Reflection Generation (Groq):**
1. Create an API key at [console.groq.com/keys](https://console.groq.com/keys)
2. Paste it in Settings → Save — encrypted immediately

Both tokens are AES-256-GCM encrypted by the `encrypt-token` Edge Function using `APP_ENCRYPTION_KEY`. The plaintext is never stored in the database.

---

## Error Codes

| Code | HTTP | Function | Meaning |
|---|---|---|---|
| `REFLECTION_NOT_CONFIGURED` | 422 | `generate-reflection` | Groq token not set — client falls back to `analyze-sentiment` silently |
| `HF_NOT_CONFIGURED` | 422 | `generate-reflection` | HF token not set |
| `HF_MODEL_LOADING` | 503 | Both | HF model cold-starting; retry in ~20 s |
| `HF_PROVIDER_ERROR` | 502 | Both | HF returned non-200 |
| `HF_SHAPE_ERROR` | 502 | Both | HF returned 200 but unrecognised shape |
| `GROQ_PROVIDER_ERROR` | 502 | `generate-reflection` | Groq returned non-200 |
| `SHAPE_ERROR` | 502 | Both | Groq returned unparseable or invalid JSON |
| `INSUFFICIENT_ENTRIES` | 422 | `generate-weekly-summary` | Fewer than `WEEKLY_REFLECTION_MIN_ENTRIES` entries in the week |
| `WEEKLY_NOT_CONFIGURED` | 422 | `generate-weekly-summary` | Groq token not set |

Provider error bodies are never forwarded to the client — logged server-side only.
