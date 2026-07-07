<h1 align="center">
  <br>
  UnSaid
  <br>
</h1>

<h4 align="center">A private journal that remembers, reflects, and quietly learns who you are.</h4>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#tech-stack">Stack</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#documentation">Docs</a> •
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <!-- TODO: Add a screenshot or GIF of the journal editor here -->
  <!-- Example: <img src="docs/images/journal-demo.gif" alt="UnSaid demo" width="600"> -->
  <em>Screenshot coming soon</em>
</p>

---

## What is UnSaid?

UnSaid is an invite-only personal journal with AI-powered emotional reflection. It is built around a single conviction:

> **Writing should feel safe. Reflection should feel understood.**

Most AI tools analyse what you write in real time. UnSaid does not. Writing is private and uninterrupted. Reflection is an explicit action you take when you are ready. And over time, the app quietly builds a memory of your life — not as a database of facts, but as a collection of moments worth remembering.

---

## Features

| | |
|---|---|
| ✍️ **Daily journal** | One entry per calendar day. Distraction-free editor with autosave and offline support. |
| 😌 **Mood tracking** | Tag each entry: terrible / bad / meh / good / great. |
| 🔥 **Streaks** | Current and longest consecutive-day streak. |
| 📅 **Year heatmap** | GitHub-style activity grid, coloured by mood. |
| 🕰️ **On This Day** | Surface entries from the same day in past years. |
| 🪞 **AI reflection** | Per-entry emotional reflection via HuggingFace + Groq — opt-in, never automatic. |
| 📖 **Weekly reflection** | Synthesises a week's entries into a narrative arc. |
| 🧠 **Memory layer** | Quietly extracts people, places, and life chapters from your journal over time. |
| 📡 **Offline-first** | Writes queue to IndexedDB and drain on reconnect. |
| 🔒 **Invite-only access** | Waitlist + admin approval flow. All data is RLS-protected. |

<!-- TODO: Add screenshots for each major feature -->
<!-- docs/images/mood-tracker.png, docs/images/insights-dashboard.png, etc. -->

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript 6, Vite 8 |
| Routing | React Router v7 |
| Data fetching | TanStack React Query v5 |
| Editor | Lexical |
| State | Zustand v5 |
| Offline queue | IndexedDB via `idb` |
| Date math | `date-fns` |
| Backend | Supabase (Postgres, Auth, Edge Functions) |
| AI | HuggingFace Inference + Groq (llama-3.1-8b-instant) |
| Deploy | Vercel (frontend) + Supabase (backend) |

---

## Quick Start

### Prerequisites

- Node.js 20+
- A [Supabase](https://supabase.com) project
- [Supabase CLI](https://supabase.com/docs/guides/cli)

### 1. Clone and install

```bash
git clone <repo-url>
cd unsaid
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
```

### 3. Apply the database schema

Run these files **in order** in the Supabase SQL Editor:

```
src/db/schema.sql
src/db/rls.sql
src/db/user_settings.sql
src/db/user_settings_rls.sql
src/db/migrations/001 → 008  (in order)
```

See [docs/deployment.md](docs/deployment.md) for the full step-by-step guide.

### 4. Run locally

```bash
npm run dev       # http://localhost:5173
npm run build     # type-check + production build
npm run lint      # ESLint
npm run test      # Vitest (single pass)
```

---

## Documentation

| Document | Description |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System design, module boundaries, data flow |
| [docs/ai.md](docs/ai.md) | AI pipeline, reflection hierarchy, prompt versioning, memory system |
| [docs/database.md](docs/database.md) | Schema, migrations, RLS policies, invariants |
| [docs/deployment.md](docs/deployment.md) | Full deployment guide for Supabase + Vercel |

---

## Project Structure

```
src/
├── app/          # App shell — providers, router, layout
├── entities/     # Domain types, DB row types, mappers
├── features/     # Page components + React Query hooks (per feature)
│   ├── auth/     # Login, waitlist
│   ├── dashboard/# Streak, heatmap, On This Day
│   ├── journal/  # Lexical editor, history
│   ├── insights/ # AI reflection dashboard
│   ├── memory/   # Life chapters + context memory hooks (M4 UI)
│   ├── settings/ # Theme, AI token configuration
│   └── admin/    # Waitlist approval panel
├── services/     # Supabase queries — always return domain types
├── shared/       # Constants, date utils, hash utils, emotion utils
├── sync/         # Offline queue (IndexedDB) + sync engine
└── db/           # SQL schema, migrations, RLS

supabase/functions/
├── analyze-sentiment/      # HF emotion classification
├── generate-reflection/    # HF + Groq → per-entry reflection
├── generate-weekly-summary/# Groq → weekly narrative
├── extract-memory/         # Entity extraction + chapter detection
├── encrypt-token/          # AES-GCM token encryption
└── approve-waitlist/       # Admin approval action
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow, branch conventions, and code guidelines.

---

## License

[MIT](LICENSE)
