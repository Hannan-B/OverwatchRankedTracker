# Patch Notes — Overwatch Ranked Tracker

> **What this is.** The single, permanent home for every patch's notes. Newest patch on top.
> Each patch has a summary table and one entry per change (symptom → root cause → fix → files →
> DB impact). Append the next patch as a new `## vX.Y.Z` section above the current one.
>
> **Convention.** "DB change? No" means no table/view/column/RLS/SQL was touched — the fix is
> client/logic only. Note it explicitly for every change so deploys never guess.

---

## v1.0.1 — in progress

Four fixes. **No schema/SQL changes** — every fix is client/logic or an asset swap.

| # | Area | Symptom | Fix | DB change? |
|---|------|---------|-----|-----------|
| 1 | Hero portrait (Shion) | Stopgap portrait, weak matcher recognition | Swapped in the official dark bank-style portrait | No |
| 2 | Hero Matchups page | Empty on every queue despite 26 games | Filter-sentinel bridge (`''` vs `'all'`) fixed | No |
| 3 | Home / summary page | Leaver games distorting overall win-rate & totals | General surfaces now respect the leaver toggle; dedicated leaver displays still always show | No |
| 4 | Beta confirmation (6f) | avg/10 cross-check flagging almost every breakdown stat | Cross-check gated to countable stats only | No |

### 1. Shion — official portrait swap

**Symptom.** Shion ran on a low-quality stopgap portrait (flat pale-lilac background) that fought
the image matcher (pale-on-pale; ORB firing on nearly every slot; occasional `role→support`
flags). See `Shion_Portrait_Notes.md`.

**Change.** Replaced the stopgap with the official portrait, converted to bank format (square,
128×128 PNG, dark/transparent background matching the other 51 portraits).

**Result (same 6 test screenshots).** Scoreboard scores rose to ~36–52% (from ~22–41%);
`role→support` flag gone (was 2, now 0); fragile Shion slots 0 (was 3); ORB fires far less;
processing time 881s → 550s total; zero wrong-hero saves. Hits the "real asset" target column in
the portrait notes.

**Files.** `public/heroes/Shion.png` (replaced). No code, no `HERO_FILENAME_MAP` edit ("Shion" is
plain ASCII → one file). No DB impact (matches stored by hero name).

### 2. Hero Matchups — empty on every queue

**Symptom.** After ~26 Tank games, Matchups showed no data on any queue (including "All Queues");
picking a hero rendered the cards but every list read "no data" and the sparsity note said "0
games." No console error; correct data in the DB.

**Investigation (ruled out, all verified healthy).** `hero_role_ref` (Shion + all 52 present);
`keepVisible`/alpha gate; `user_role_played` values; RLS/session; season tagging; stale deploy;
front-end roster (`reference.ts`). The 207 pair rows reached the browser correctly.

**Root cause.** `toMatchupFilters` (in `analytics/matchups/page.tsx`) bridged the shared
`AnalyticsFilterState` to the lib's `MatchupFilters` using `??`. The shared `map` sentinel is `''`
(= "all maps"), but `matchups-lib`'s `passesFilters` uses `'all'` as the "no filter" sentinel and
treats any other string — including `''` — as a literal map name to match. `'' ?? 'all'` stays
`''` (nullish coalescing only replaces null/undefined), so the check became `r.map !== ''`, true
for every real row → **every row dropped, all queues empty.** The same line in `SparsityNote`
produced "0 games."

**Fix.** Changed the coalesce from `??` to `||` on all three bridged fields (queue/mode/map) so an
empty-string sentinel becomes `'all'`. Verified end-to-end against real rows: rows now pass under
All Queues and Tank, and real map/mode selections still filter correctly.

**Files.** `src/app/analytics/matchups/page.tsx` (`toMatchupFilters`, 3 lines). No lib, no SQL, no
DB.

**Known gap recorded (not a bug yet).** Matchups does not implement the season filter at all
(`MatchupFilters` has no `seasons` field; the filter bar renders without a season control), so it
is all-time only. Harmless while a single season exists; to add when a 2nd season starts: add
`seasons` to `MatchupFilters`, thread it through `toMatchupFilters`, check it in `passesFilters` +
`SparsityNote` (pair rows already carry `season_id`), enable the control. ~30-min job mirroring
the existing `matchesFilters` pattern.

### 3. Home / summary — leaver games in overall figures

**Symptom.** The Home page counted leaver games in the headline win-rate cards and games-played
totals, so a leaver loss dragged down "overall" stats. The Settings "show leaver games" toggle was
ignored on this page.

**Desired behaviour.** General surfaces should respect the toggle (exclude leaver games when off),
but the *dedicated* leaver displays — which exist specifically to report leavers — should always
show leaver data regardless of the toggle.

**Fix.** Added `scopedVisible` (the toggle-respecting set) alongside the existing unfiltered
`scoped`, mirroring the `overviewVisible` rule the #14 block already used:
- **General surfaces → `scopedVisible`:** four win-rate cards, games-played total + category
  counts, Last-5, recent-form pips. Leaver games excluded when the toggle is off.
- **Dedicated leaver displays → unfiltered `scoped`:** the big "Leaver Games" box
  (`leaverSplit(scoped)`) and each card's `LeaverLine`. `WinRateCard` gained an optional
  `leaverRows` prop (fed the unfiltered per-category set) so its win rate respects the toggle while
  its leaver line always shows.
- Empty-state notice stays on `scoped` (a leaver-only season shouldn't read "no matches").
- #14 current-season overview unchanged (already respected the toggle).

**Verified.** Toggle off: win rate/total shrink to non-leaver games while leaver box/line still
report real counts. Toggle on: everything includes leavers. (Traced numerically.)

**Files.** `src/app/page.tsx`. No SQL, no DB (reads existing columns).

### 4. Beta confirmation — avg/10 cross-check false flags

**Symptom.** On the `/process` 6f confirmation cards, almost every breakdown stat was flagged with
the "Doesn't add up" (`avg_crosscheck_fail`) signal — persistently, across most matches.

**Evidence (`beta_issue_log`).** 94 `avg_crosscheck_fail` rows, **all** resolved `confirmed_correct`
with no correction — every flag a false alarm. Failures clustered entirely on percentage stats
(WEAPON ACCURACY, ENERGY JAVELIN ACCURACY, PUMMEL ACCURACY…), the one time stat (OBJ CONTEST TIME),
and near-zero counts (SOLO KILLS 0, FINAL BLOW 1).

**Root cause.** `avgCrossCheckCandidates` (in `src/lib/beta-confirmation.ts`) ran the check
`value ≈ avg_per_10 × (playtime/600)` on **every** stat regardless of type. The time and formula
were already correct (uses the hero's `playTimeSeconds`, not game length — so "played 2 min of a
15-min game" was not the cause). The problem: percentages and durations have no `× playtime/10`
relationship, and `numericValue` mangles them (`"40%" → 40`, `"01:51" → 151`), so on any game that
wasn't exactly 10 minutes the expected value drifted from the read value and tripped the ±40% band.
Near-zero counts tripped on rounding.

**Fix.** Gated the cross-check to countable stats using metadata that already existed in
`stat-meta.ts`:
- `if (statFormat(normaliseStat(st.statName)) !== 'number') continue` — skip percent/time stats.
- `if (value < 2 && expected < 2) continue` — skip near-zero counts.
- Imports `statFormat`, `normaliseStat` from `@/data/stat-meta`.

The check is **kept**, not removed — it still fires for a genuine OCR error on a real count stat
(traced: value 20 with a misread avg/10 of 50 still flags at 67% deviation). All 94 logged false
flags now pass.

**Files.** `src/lib/beta-confirmation.ts`. No SQL, no DB.

**Future (out of scope for v1.0.1).** `avg_per_10` is still OCR'd off the screen (~60% reliable). A
later change could *compute* the displayed per-10 from the trusted per-game value + playtime and
stop showing the OCR'd number entirely — making the shown per-10 reliable, not just suppressing
false flags.

### Deploy checklist — v1.0.1

Files to ship:
1. `public/heroes/Shion.png`
2. `src/app/analytics/matchups/page.tsx`
3. `src/app/page.tsx`
4. `src/lib/beta-confirmation.ts`

Docs updated:
- `FILE-MAP.md` — title bumped to v1.0.1; version header + Home / Matchups / beta-confirmation
  entries updated. (Local-only / gitignored — re-upload next session.)
- `Supabase Map.md` — no change (no DB touched this patch).

Before commit: `npm run build` (typecheck + lint clean), then commit + push (Vercel auto-deploys).
Post-deploy: hard-refresh, unregister the service worker, and spot-check Matchups (pick a hero →
lists populate), Home (toggle leaver setting → general stats shift, leaver box constant), and a
`/process` run (avg/10 no longer over-flagging).

---

<!--
## vX.Y.Z — template for the next patch (copy this block up top)

One-line summary. DB change? Yes/No.

| # | Area | Symptom | Fix | DB change? |
|---|------|---------|-----|-----------|
| 1 |      |         |     |           |

### 1. <title>
**Symptom.**
**Root cause.**
**Fix.**
**Files.**  No SQL, no DB. (or: describe the DB change + which map entry was updated)

### Deploy checklist — vX.Y.Z
Files to ship: ...
Docs updated: ...
-->
