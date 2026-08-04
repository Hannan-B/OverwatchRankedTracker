# Patch Notes — Overwatch Ranked Tracker

> **What this is.** The single, permanent home for every patch's notes. Newest patch on top.
> Each patch has a summary table and one entry per change (symptom → root cause → fix → files →
> DB impact). Append the next patch as a new `## vX.Y.Z` section above the current one.
>
> **Convention.** "DB change? No" means no table/view/column/RLS/SQL was touched — the fix is
> client/logic only. Note it explicitly for every change so deploys never guess.

---

## v1.0.2 — released 4 August 2026

Scoreboard hero identification: **21.9% wrong → 0%**. Two code fixes, one feature
replacement, one data repair. **DB change? Yes** — 4 nullable columns on `beta_issue_log`,
plus corrective UPDATEs to existing rows.

| # | Area | Symptom | Fix | DB change? |
|---|------|---------|-----|-----------|
| 1 | OpenCV worker | 1 scoreboard hero in 5 wrong; worse the longer a session ran | Released the leaked `cv.ORB` / `cv.BFMatcher`; added worker restart + health telemetry | No |
| 2 | Hero matcher | 2 remaining errors, both auto-correct overrides | `AUTO_CORRECT_MIN_LEAD` calibrated 0.05 → 0.10 from logged data | No |
| 3 | Confirmation (6f) | Gate only asked about suspected errors — 60 of 71 real errors were never questioned | Beta confirmation sunset; replaced by a per-slot audit of every scoreboard row | **Yes** (4 columns) |
| 4 | Historical data | 71 wrong heroes, `role_played` stuck on `'dps'`, 9 bad `percent_played` | Corrective SQL from ground truth | **Yes** (data) |

### 1. OpenCV worker — ORB/BFMatcher heap leak

**Symptom.** The 6v6 scoreboard stored the wrong hero for **71 of 324 slots (21.9%)**, across
24 of 27 matches. Everything else in the same extraction was perfect: all 1,944 numeric cells,
all 324 `is_user` flags, all 116 map/result/score/game-length fields, all 47
`play_time_seconds`. Only the portrait→hero mapping was wrong. Accuracy also degraded the
longer a `/process` session ran, which looked like an unrelated build/deploy issue.

**Investigation (four prior test runs, all inconclusive).** Errors moved 27 → 37 → 16 → 49
across four configurations without resolving. Ruled out and verified healthy: image quality
(all 3840×2160, Laplacian 423–442, ally table top edge 470–472 px in every image), bank
portrait resolution (64 vs 128 flips 0 of 12 failing pairs), and `ORB_THRESHOLD` tuning.

**Root cause.** `orbMatch()` in `public/opencv-worker.js` constructed a `cv.ORB` and a
`cv.BFMatcher` on **every call** and deleted neither. Both are C++ objects on the Emscripten
heap that JavaScript GC cannot reclaim. After ~17,300 calls the heap was exhausted;
`cv.matFromImageData` then threw, `combinedScore()` caught it, logged a bare message with no
detail, and silently substituted `orb = 0` — so the matcher carried on scoring on
`0.6*structural + 0.4*colour` while still reporting results on the ORB scale. Secondary leak:
`kp1/kp2/des1/des2/mask` were deleted on the last line of the `try`, so any throw leaked them.

**Evidence.** With `orb = 0` a Pass-2 score is exactly half the no-ORB score of the same crop,
and `phase1Score` is ORB-independent, so the ratio is a direct test:

| Region of the 2 Aug run | mean `score / phase1Score` | errors |
|---|---|---|
| Tests 1–18 (ORB alive) | **1.312** | 2 of 204 — **0.98%** |
| Tests 19–29 (ORB dead) | **0.508** | 14 of 120 — **11.67%** |

9,146 `ORB match failed` warnings in the log, first appearing mid-match 18 of 27. Measured
budget: ~17,300 ORB calls, mean ~1,040 per match (range 224–2,176). The worker is
module-level in `opencv-loader.ts` and lives for the whole page session, so `/process`
accumulated the same leak across matches — roughly game 15–17 of a session, as early as 8–9
on heavy matches. Reloading reset it, which is why it was never noticed live.

**Fix.** `ORB_DETECTOR` / `BF_MATCHER` hoisted to module scope and constructed once; every Mat
and vector released in a `finally`. Worker terminate-and-restart after 3 consecutive failures
(freeing the whole WASM heap), hard stop after 3 restarts. The `catch` now logs its exception.
`/testing` parses a new `ORB HEALTH` line into the Overall table with a 🛑 banner when any
match ran degraded — a run where ORB dies partway is two algorithms reported as one.

**Result.** 16/324 → **2/324**. Tests 19–29 went from 11.67% to 0.00%; tests 1–18 unchanged at
0.98%. Verified no behavioural side effects: tests 1–5 came back **bit-identical** to the
previous run — same hero, same score to 4 dp, same margin, same crop pick on all 60 slots.

**Files.** `public/opencv-worker.js`, `src/lib/opencv-loader.ts`, `src/lib/hero-matcher.ts`,
`src/lib/scoreboard-extractor.ts`, `src/app/testing/page.tsx`. No SQL, no DB.

### 2. Hero matcher — AUTO_CORRECT_MIN_LEAD calibration

**Symptom.** With the leak fixed, 2 errors remained — both Soldier: 76 read as Zenyatta, both
auto-correct overrides where `matchHero` left the role-filtered candidate set.

**Root cause.** `AUTO_CORRECT_MIN_LEAD` was 0.05, an explicit placeholder ("uncalibrated —
both scores are logged so it can be tuned from real data").

**Evidence.** 87 logged decisions, 55 OVERRIDE. Restricting to Pass-1-final slots — the only
ones the override actually decides, since Pass 2 overwrites Pass 1 unconditionally:

| Outcome | Count | Lead range |
|---|---|---|
| Correct overrides | 6 | 0.2534 – 0.3570 |
| **Wrong overrides** | **2** | **0.0760, 0.0771** |

An empty 0.18 gap. Of the 13 overrides in the affected [0.05, 0.10) band, 11 sat on slots that
go to Pass 2 anyway (no effect — and blocking them cannot change *whether* they reach Pass 2,
since an override only fires when the full score exceeds the filtered score, so reverting
always lowers it and all 11 were already below `ORB_THRESHOLD`). None of the 26 Pass-2-internal
overrides fell in the band. **Net: exactly 2 slots could change, and both were wrong.**

**Fix.** `AUTO_CORRECT_MIN_LEAD` 0.05 → 0.10.

**Result.** 2/324 → **0/324**. Exactly the 2 predicted slots changed, both wrong → right; no
second-order effects through crop selection.

**Do not "fix" this by raising `ORB_THRESHOLD` instead.** Both errors sat at score 0.363, just
above the 0.35 gate, so pushing them into Pass 2 looks equivalent — but 0.35 → 0.40 pulls 56
slots into Pass 2 of which **54 are already correct**.

**Files.** `src/lib/hero-matcher.ts`. No SQL, no DB.

### 3. Beta confirmation sunset → per-slot hero audit

**Symptom.** The confirmation step asked only about slots a confidence threshold flagged. Of
the 71 real errors, **60 were never questioned** — the matcher was confident and wrong. The 11
that were questioned were all corrected correctly by the user, and **all 11 corrections were
discarded on save**: `hero_id` was the one confirmation field with no write-back.

**Root cause.** A confidence gate can measure *precision* (how often a flag was a real error)
but never *recall* (how many errors were never flagged). No threshold fixes that, because the
errors it misses are invisible by construction. Separately, the existing gate fires on
`confidence < 0.6` while every one of the 324 slots scores below 0.6 (range 0.143–0.559), so
it would have asked 3 questions per match — the cap — all false alarms.

**Fix.** Beta confirmation retired. New `HeroAuditPanel` confirms **every** scoreboard row
(10 for 5v5, 12 for 6v6) in strict scoreboard order, with a tappable portrait per row, a
type-ahead hero search over the full roster, and a bulk "confirm remaining" gated on any
coherence-flagged row being resolved first. No row is pre-accepted — a row nobody looked at
must not record identically to one checked carefully.

Two deterministic coherence checks flag rows in place: duplicate hero within **one** team
(cross-team duplicates are legal) and the user's hero absent from `heroes_played`. Measured
on the ground-truth set: 4 real errors, 0 false positives across 324 slots. No role-shape
check — 6v6 here is open queue (one test has a 2-3-1 enemy team) and a 2-2-2 rule would
manufacture errors.

`onAuditComplete` writes confirmed heroes back into all four arrays that carry `heroName`,
re-deriving `role` from the confirmed hero, before the unchanged `saveMatch`.

**DB impact.** `beta_issue_log` gains `slot int`, `margin numeric`, `runner_up text`,
`orb_applied boolean` — all nullable, `event` CHECK unchanged (the audit reuses
`confirmed_correct` / `corrected`). `logHeroAudit()` writes one batched row per slot,
confirmed **and** corrected: a confirmed row's `corrected_value` is the truth label, and
omitting it would discard the negative examples that make an error rate computable. At ~400
matches a season this is ~4,800 labelled slots.

`orb_applied` is the important one — Pass 1 and Pass 2 use different scoring formulas, so
`confidence` and `margin` must **never** be pooled across them. Pooling is what made the §1
leak invisible for four test runs.

`/issue-log` reworked for the new grain: error rate by scoring scale, by margin band,
confusion pairs, bulk-confirmed share. `precisionBySignal` retained but filtered to historical
signals only.

**Known regression, accepted.** The map and result write-backs went with beta confirmation, so
a missed map (which drives `starting_side` and `game_mode`) and an unreadable win/loss banner
are no longer correctable at save time. Both fire rarely. Detection SQL is the replacement:
periodic cross-checks for a map missing or not in the catalog, `game_mode` disagreeing with the
map, `starting_side` set on a symmetric map or missing on an asymmetric one, and `result`
disagreeing with `score`. The `unrecognized` new-content ledger is also now silent; the `/testing` readiness panel covers it, but only if run manually.

**Files.** `src/app/review/HeroAuditPanel.tsx` (new), `src/app/process/page.tsx`,
`src/lib/beta-issue-log.ts`, `src/lib/types.ts`, `src/lib/scoreboard-extractor.ts`,
`src/app/issue-log/page.tsx`. `beta-confirmation.ts` and `review/ConfirmationCard.tsx`
retained but referenced by nothing. **DB: yes** — run the migration before deploying.

### 4. Historical data repair

**Symptom.** Three fields wrong in stored data, none recoverable by re-processing (feel and
star ratings on `matches` are subjective and cannot be recalled).

**Fix.**
- `scoreboard_players.hero_name` + `role` — corrected for all 324 slots across the 27 6v6
  matches with a scoreboard. Numeric stat columns untouched (all 1,944 verified correct).
  Everything downstream is a **view**, so corrections propagated automatically.
- `matches.role_played` — was stuck on `'dps'`, firing `role_mismatch` on 25 of 29 matches and
  making every role-split analytic read a constant. Repopulated from `roles_played` for
  single-role matches.
- `hero_performances.percent_played` — wrong on 9 of 47 rows. Recomputed from
  `play_time_seconds` (correct on all 47), **guarded** to matches whose stored rows account for
  the full game length: 11 matches store fewer rows than were played, and recomputing there
  would inflate the survivors (one match kept only the 26% hero and would have become 100%).

**Gotchas recorded.** The `match_id = 263 + test_number` mapping is valid **only** with alpha
rows excluded — 9 alpha matches sort first and shift every index by nine. And
`matches.role_played` is an enum (`role_type`) while `scoreboard_players.role` is `text`;
comparing them directly raises `operator does not exist: role_type = text`, so cast both sides
to `::text`. Introspect column types before writing DDL — `Supabase Map.md` is for
orientation, not schema truth.

**DB: yes** — data only, no schema change from this item.

### Deploy checklist — v1.0.2

**Run the migration FIRST** — `beta_issue_log` + 4 columns. The new code writes them; without
the columns `logHeroAudit()` 400s on the first saved match. Verify:

```sql
select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='beta_issue_log'
  and column_name in ('slot','margin','runner_up','orb_applied');
-- expect 4 rows
```

Files to ship:
1. `public/opencv-worker.js`
2. `src/lib/opencv-loader.ts`
3. `src/lib/hero-matcher.ts`
4. `src/lib/scoreboard-extractor.ts`
5. `src/lib/types.ts`
6. `src/lib/beta-issue-log.ts`
7. `src/app/review/HeroAuditPanel.tsx` (new)
8. `src/app/process/page.tsx`
9. `src/app/testing/page.tsx`
10. `src/app/issue-log/page.tsx`

Docs updated:
- `Supabase Map.md` — `beta_issue_log` +4 columns; repair records on `scoreboard_players` and
  `matches`; the enum-vs-text gotcha.
- `FILE-MAP.md` — bumped to v1.0.2; entries added or amended for opencv-worker, opencv-loader,
  hero-matcher, scoreboard-extractor, types, beta-issue-log, process, testing, issue-log and
  HeroAuditPanel, with SUNSET markers on beta-confirmation and ConfirmationCard.

Post-deploy: hard-refresh, unregister the service worker, then process **one real match** and
check (a) the audit panel renders all 10/12 rows, (b) the save succeeds — a 400 here means the
migration didn't run, (c) `/issue-log` shows slot-level rows with margins populated.

**Watch after deploy.** The ORB health line should show `failed=0`. If the Pass-2 share of
slots collapses toward zero in `/issue-log`, ORB has stopped running again — that is the leak
signature, not a matcher problem, and the fix is in the worker rather than the matcher.

---

## v1.0.1 — released

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
