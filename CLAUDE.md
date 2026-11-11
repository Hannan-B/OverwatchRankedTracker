# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal, single-user Progressive Web App for tracking *Overwatch 2* competitive matches.
The user photographs the post-match screens on console (summary, per-hero breakdown,
scoreboard), uploads them from a phone, and the app extracts match data from the images
client-side (no image is ever sent to a recognition service) — then turns the history into
dashboards, hero breakdowns, and matchup analysis. See [README.md](README.md) for the
full feature list and user-facing description.

**Tech stack:** Next.js 14 (App Router) + React 18 + TypeScript + Tailwind CSS · Supabase
(Postgres + Auth + Storage) · OpenCV.js (hero-portrait template matching, in a Web Worker)
· Tesseract.js (OCR) · Recharts · Vercel hosting.

## Commands

```bash
npm run dev      # local dev server (localhost:3000)
npm run build    # production build
npx tsc --noEmit # typecheck only
npm run lint     # next lint
```

There is no automated test suite. Correctness is validated against real screenshots via
the **`/testing`** page (a dev harness that runs the full extraction pipeline and shows
results on screen — it never writes to the database) and the **`/test-breakdowns`** page
(breakdown-OCR harness). Before pushing a change that touches extraction, run screenshots
through `/testing` and eyeball the source-image-vs-extracted-data pairing rather than
trusting a green build alone.

`npm run build && npx tsc --noEmit` must both pass with zero errors before pushing —
Vercel auto-deploys `main` and the production build is stricter than the dev server.

## Architecture

### Two-device, two-phase data pipeline

This is the core architecture and almost everything else hangs off it:

```
PHONE (/upload)                LAPTOP (/process)                 ANALYTICS PAGES
collects answers      ──▶      processMatchPhotos()      ──▶     read VIEWS
+ screenshots                  + confirmation/audit              (never raw tables
→ Supabase Storage              → writes BASE TABLES              for analytics —
  pending/                       (matches, hero_performances,      Home is the one
                                  hero_stats, scoreboard_players)   documented exception)
```

- **`/upload`** (phone): captures screenshots + a short set of subjective questions
  (matchup feel, performance rating, fun rating, leaver/thrower per team, standout hero
  picks) and stashes everything in Supabase Storage under `pending/` — nothing is
  processed yet.
- **`/process`** (laptop, `src/app/process/page.tsx`, marked HIGH-INVARIANT in the repo's
  own file map): two-phase — Phase 1 runs `processMatchPhotos()` unattended over every
  pending batch and holds results in memory; Phase 2 steps through each match for human
  audit (hero identification correction, username confirmation, a "6f" quick-check) and
  saves the instant that match's review clears. Screenshot files are deleted from Storage
  only after a successful save.
- **Extraction pipeline** (`src/lib/image-processor.ts` orchestrates): auto-detects
  summary vs. breakdown vs. scoreboard screenshots, identifies heroes by portrait
  template matching (`hero-matcher.ts`, OpenCV ORB + structural + color-moment scoring in
  a Web Worker via `opencv-loader.ts`), reads scoreboard/stat numbers via pixel-template
  OCR (`breakdown-ocr.ts`, `ocr-extractor.ts`, `scoreboard-extractor.ts` — all calibrated
  to fixed 3840×2160 PS5 screenshot coordinates), and works out map/result/format.
- **Audit before save**: every scoreboard row is shown against its source image region
  before saving (`review/HeroAuditPanel.tsx`) — low-confidence reads are flagged but
  nothing is auto-hidden, so a confident-but-wrong read still gets checked.
- **Analytics pages** read Supabase **views**, not base tables, so aggregation logic
  lives in SQL and pages just filter/chart. Each analytics surface pairs a `page.tsx`
  with a React-free `*-lib.ts` (fetch → filter → memoised aggregation → Recharts render).

### Visibility layers (compose across most analytics surfaces)

Three independent, stacking filters — all documented as "single source of truth" modules:

- **Alpha/test data** (`src/lib/alpha.ts`): matches saved from localhost are stamped
  `is_alpha = true`. Live site always excludes them; localhost shows/hides via one
  `localStorage` dev switch. Pages reading the `matches` table directly use
  `matchQuery()`; pages reading views with an `is_alpha` column fetch everything and
  filter with `keepVisible()` in JS (views can't tell localhost from live).
- **Leaver handling** (`src/lib/leaver.ts`): three distinct cases, not one boolean —
  a **permanent** leaver (`leaver_type = 'left'`) discards the scoreboard entirely (no
  `scoreboard_players` rows exist); a **returned** leaver keeps a full, valid scoreboard
  whose numbers are just skewed; a **thrower** is a completely valid scoreboard excluded
  purely by preference. Always branch on `leaver_type`, never on the legacy boolean
  columns (`team_leaver`/`enemy_leaver`) — the booleans are true for both permanent and
  returned cases, so testing them re-discards boards the type-based rewrite exists to keep.
- **Season filtering**: `seasons: number[]`, `[]` = All Time. `season-util.ts` centralises
  the "default to current season, else All Time" logic used by every season-aware page.
- Confidence cue across analytics: items under `MIN_GAMES` (default 5) are **dimmed, not
  dropped** ("honest coverage") — except the Heroes list (`analytics/heroes/page.tsx`),
  which is a deliberate hard-gate exception (stated in its own UI copy) because it's a
  browsing grid, not a ranking.

### Database (Supabase) — dynamic by default, two hardcoded exceptions

One Postgres database shared by local dev and production (RLS on, permissive
authenticated-full-access policy). Base tables (`matches`, `hero_performances`,
`hero_stats`, `scoreboard_players`, `seasons`, `user_settings`, `match_images`,
`beta_issue_log`, builder saved-chart tables) hold real data written by processing;
analytics **views** compute aggregates on top and are what pages actually read.

Adding a new **map** needs zero database change — map surfaces group dynamically from
match data. Adding a new **hero** needs exactly one required SQL update
(`hero_role_ref` + `hero_role_history`, hardcoded hero→role lists — 54 heroes as of
Season 5 — that Matchups depends on; `/testing`'s readiness panel generates both) and
conditionally a second (`hero_stats_normalised`, which hardcodes ~125 stat-name fold
rules — only needed if the hero introduces a brand-new stat name). Both are safe,
reversible `CREATE OR REPLACE VIEW` statements. Everything else (win rates, play time,
damage/healing shares, season/role/map splits) is dynamic.

**A hero can change role** (Sombra: DPS → support from Season 5, 2026-10-06). Roles are
date-based: `HEROES[].previously` + `heroRoleAt(hero, playedAt)` in code, and
`hero_role_history` (valid_from / valid_to) joined by game date in SQL. Never look a
hero's role up without the match date.

**Bulk session upload** (v1.2.0) sits alongside the per-match wizard, which is kept
unchanged: `/upload` → `pending/session-<ts>/`, then `/process` reads each screenshot
(`session-fingerprint.ts`), groups them (`session-grouper.ts`, pure), shows
`SessionPreview`, and runs `processMatchPhotos` per match. Clean matches auto-save; anything
`sessionMatchExceptions` flags is held for the normal review. Bulk matches have no
question answers (NULL) and no returned-leaver/thrower flags.

**Heroes and maps are not database rows** — they're entries in the `HEROES`/`MAPS` lists
in [src/data/reference.ts](src/data/reference.ts). Adding a new season's content is a
code + one-or-two-SQL-statement change, documented step-by-step in the (gitignored,
local-only) New Season Runbook — see "Local-only docs" below.

⚠️ Postgres keeps no history of view definitions. Before editing any view, dump the live
definition with `pg_get_viewdef` rather than trusting what any doc says was applied — a
documented migration is not necessarily a live one.

### Directory layout

- `src/app/` — Next.js App Router routes. Analytics surfaces live under
  `src/app/analytics/<name>/` and typically pair `page.tsx` with a co-located
  `<name>-lib.ts` for pure aggregation logic.
- `src/lib/` — mostly React-free logic: the extraction/OCR/matching pipeline, Supabase
  clients, and the visibility-layer single-source-of-truth modules described above.
- `src/data/` — static reference data: `reference.ts` (heroes/maps/seasons),
  `hero-stat-catalog.ts` (expected breakdown stats per hero, used for extraction
  validation), `stat-meta.ts` (stat display metadata).
- `src/components/` — shared UI (theming, filters, auth gate, generic `Select`/
  `MultiSelect`).

### Conventions worth knowing before editing

- Every native `<select>` should use the themed generic `<Select<T>>` component, not a
  raw `<select>`.
- Every Recharts page pulls colors from `useChartColors()` (live light/dark palette) —
  don't reintroduce hardcoded chart color constants.
- Color literals (`text-slate-*`, `text-white`, etc.) have been migrated to theme tokens
  (`text-ow-fg`/`muted`/`faint`, `border-ow-line`, `placeholder-ow-faint`) so light/dark
  works automatically; a few deliberate exceptions remain (the hardcoded-dark
  `/test-breakdowns` dev page, `text-white` on solid result-color fills). Match existing
  token usage rather than reaching for raw Tailwind color classes.
- `PATCH-NOTES.md` is the permanent record of shipped changes (symptom → root cause → fix
  → files → DB impact, newest on top) — check it before assuming a past bug is still
  present, and follow its format when documenting a fix of your own.
  `PATCH-NOTES-SIMPLE.md` is its plain-English twin: one bullet per change under Added /
  Changed / Fixed / Retired / Database / Known limits. Every patch gets an entry in BOTH.
- `Supabase Map.md` documents the live schema; treat its narrative as orientation, not
  schema truth — verify column types/constraints against the database itself before
  writing SQL (e.g. `role_played` is a Postgres enum while `scoreboard_players.role` is
  `text`; comparing them needs an explicit `::text` cast).

### Local-only docs (gitignored, not in this checkout by default)

`FILE-MAP.md`, `New Season Runbook.md`, `KNOWN-FAILURE-MODES.md`, and
`MAP-RESULT-DETECTION.md` are deliberately excluded from git and live only on the owner's
machine, even though the repo is private. If the user has uploaded one of these into the
session, treat it as authoritative, detailed context (FILE-MAP.md in particular maps
every file's exports/state/data-flow, not just its location) — but don't expect to find
them by browsing the repo, and don't assume they're current if the owner didn't just
provide them.
