# Contributing to UnSaid

Thank you for your interest in contributing. This document covers the development workflow, code conventions, and standards that keep the codebase consistent.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Branch Conventions](#branch-conventions)
- [Code Standards](#code-standards)
- [Testing](#testing)
- [Commit Messages](#commit-messages)
- [Documentation Policy](#documentation-policy)
- [What We Don't Accept](#what-we-dont-accept)

---

## Getting Started

1. Fork and clone the repository
2. Install dependencies: `npm install`
3. Copy the environment file: `cp .env.example .env`
4. Fill in your Supabase project credentials
5. Run the dev server: `npm run dev`

See [docs/deployment.md](docs/deployment.md) for the full database and Edge Function setup.

---

## Development Workflow

All work happens on feature branches. Never commit directly to `main`.

```bash
git checkout -b feature/your-feature-name
# ... work ...
npm run lint    # must pass
npm run build   # must pass
npm run test    # must pass
git push origin feature/your-feature-name
# open a pull request
```

CI will run automatically on every push and pull request. All checks must pass before a branch is considered mergeable.

---

## Branch Conventions

| Prefix | Use |
|---|---|
| `feature/` | New features or milestones |
| `fix/` | Bug fixes |
| `docs/` | Documentation-only changes |
| `refactor/` | Code restructuring without behaviour change |
| `chore/` | Dependency updates, tooling, config |

Use kebab-case. Be descriptive: `feature/memory-before-intelligence`, not `feature/mem`.

---

## Code Standards

### TypeScript

- `verbatimModuleSyntax` is enabled — type-only imports **must** use `import type { … }`
- `noUnusedLocals` and `noUnusedParameters` are enforced — unused params must be prefixed with `_`
- No decorators, no `const enum` (`erasableSyntaxOnly: true`)
- `@/` alias resolves to `src/` — use it for cross-feature imports

### Architecture rules

These are not suggestions — they are invariants. Breaking them silently corrupts data.

- **Never call services from `.tsx` files** — all service calls go through React Query hooks in the feature's `hooks.ts`
- **Never return raw DB rows** from services — always map through `xFromRow()` entity mappers
- **All journal writes go through `syncEngine.enqueueEntry()`** — never direct service calls
- **`entry_date` is always a local `"YYYY-MM-DD"` string** — use `getTodayLocal()` from `src/shared/utils/dates.ts`, never `toISOString()`
- **Memory tables are service_role-only writes** — no client mutation hooks for `life_chapters`, `context_memory`, `chapter_entries`, `memory_extractions`

See [`AGENTS.md`](AGENTS.md) for the full list of invariants.

### Error handling

- All service errors must extend [`ServiceError`](src/services/errors.ts) with a `code: string` field
- Use [`unwrap()`](src/services/errors.ts) for Supabase responses — never check `.error` manually inline
- Never `throw new Error()` in the service layer

### Query keys

Follow the factory pattern from [`journalKeys`](src/features/journal/hooks.ts) for all new feature query keys. Keys start with a root array `['featureName'] as const`.

### Optimistic updates

Mutations that write user data must implement the full pattern:
1. Cancel in-flight queries
2. Snapshot previous state
3. Apply optimistic update
4. Roll back on error
5. Invalidate on settled

See [`useUpsertEntry`](src/features/journal/hooks.ts) as the canonical example.

---

## Testing

```bash
npm run test         # single pass (Vitest)
npm run test:watch   # watch mode
npx vitest run src/__tests__/specific.test.ts  # single file
```

- Tests live in `src/__tests__/`
- Use `fake-indexeddb` for IndexedDB tests (`import 'fake-indexeddb/auto'`)
- Entity mapper tests are required for any new entity
- Tests must not make real network calls or touch Supabase

---

## Commit Messages

Use the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <description>

<body (optional)>
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

**Examples:**

```
feat(memory): add chapter dormancy sweep to extract-memory pipeline
fix(journal): prevent autosave race on editor initialisation
docs: update deployment guide with migration 008 steps
test(memory): add unit tests for chapterEntryFromRow mapper
```

Keep the subject line under 72 characters. Use the body for `why`, not `what`.

---

## Documentation Policy

**Temporary milestone planning documents** must be deleted before a milestone is considered complete.

All important information should be incorporated into the permanent documentation:
- `README.md` — project overview, quick start
- `docs/architecture.md` — system design and invariants
- `docs/ai.md` — AI pipeline and prompt versioning
- `docs/database.md` — schema, migrations, RLS
- `docs/deployment.md` — deployment guide

Git history preserves every version of deleted documents. The repository should represent the **current architecture**, not every discussion that led to it.

**Exception:** Long-term design decisions (significant architectural choices, trade-offs) may be documented as Architecture Decision Records under `docs/adrs/` when introduced. These are intentionally immutable.

---

## What We Don't Accept

- Direct Supabase calls in `.tsx` components
- Mutations that bypass the sync engine
- `import type` violations (verbatimModuleSyntax)
- Background AI inference without explicit user action
- New UI that exposes memory data before M4 is approved
- Commits that break `npm run build`, `npm run lint`, or `npm run test`
