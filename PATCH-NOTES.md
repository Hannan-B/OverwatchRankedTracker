# Patch Notes — Overwatch Ranked Tracker

> **What this is.** The single, permanent home for every patch's notes. Newest patch on top.
> Each patch has a summary table and one entry per change (symptom → root cause → fix → files →
> DB impact). Append the next patch as a new `## vX.Y.Z` section above the current one.
>
> **Convention.** "DB change? No" means no table/view/column/RLS/SQL was touched — the fix is
> client/logic only. Note it explicitly for every change so deploys never guess.

---

## v1.1.1 — released 15 August 2026

Adds **D.Mon** (hero 53). Gathering evidence for that hero surfaced four pre-existing
defects, none of which were caused by the hero addition; all are fixed here. **DB change?
Yes** — two view rebuilds (`hero_role_ref`, `hero_stats_normalised`), no tables or columns.

⚠️ **Two heroes' worth of stats stop accruing.** The season that added D.Mon also added a
`PLAYERS PROTECTED` tile to every tank, and the breakdown screen holds a hard maximum of
eight tiles. Five tanks were already at eight, so the game **dropped their ultimate tile**
to fit: Domina `PANOPTICON HITS`, Junker Queen `RAMPAGE KILLS`, Reinhardt `EARTHSHATTER
KILLS`, Sigma `GRAVITIC FLUX KILLS`, Wrecking Ball `MINEFIELD KILLS`. Historical values
remain readable — those charts simply flatten from this season onward. **This is not a
regression.**

⚠️ **`PLAYERS PROTECTED` is blank on all 192 historical matches, permanently.** The tile
did not exist before ~31 July 2026 and no backfill is possible.

| # | Area | Symptom | Fix | DB change? |
|---|------|---------|-----|-----------|
| 1 | New hero | D.Mon absent everywhere | Added across reference, role map, portrait, stat-meta, catalog, and both hardcoded views | **Yes** (2 views) |
| 2 | New role tile | `PLAYERS PROTECTED` on every tank's screen, nowhere in the app | Registered on all 15 tanks + both Heroes pages; five tanks swapped an ultimate tile for it | **Yes** (view) |
| 3 | Stat folding | `FINAL BLOW(S)`, `SOLO KILL(S)`, `PLAYER(S) SAVED` unregistered in code — every foldable ROLE tile | Four pairs added to `STAT_NORMALISE`; the SQL view already had them | No |
| 4 | Match result | Two of ten test matches stored as a LOSS when the banner read VICTORY | Deleted a duplicate score-derived rule that overrode the banner | No |
| 5 | 6v6 scoreboard | Roles read 5-0-1 on both teams; portrait scores 13.8% with 12/12 rows flagged | Root cause: the table is centred and its width varies, so every fixed x-coordinate drifts. 6v6 coordinates now derived from the measured table edge | No |
| 6 | Stat catalog | A hero's stat order is positional and eight tank entries were out of order | Reordered to true screen order; a mis-ordered entry silently mislabels a recovered tile | No |
| 7 | Matchups | Only surface still opening on All Time now that a second season exists | Seeds the current season once, like every other season-aware page | No |
| 8 | Monitoring | Two hypotheses now under watch with no way to confirm them | Tile-ceiling check every 3rd sighting; table geometry logged on every scoreboard | No |

### 1. D.Mon — hero 53

`D.Mon` / tank / stalwart. Plain-ASCII plus a dot, so one portrait file and no
`HERO_FILENAME_MAP` entry — the same class as `D.Va`. Five breakdown stats: Fusion Repeater
Accuracy (percent, per-10 shown), Fusion Repeater Kills, Knockback Kills, Limit Break Kills,
Damage Amplified.

`FUSION REPEATER KILL(S)` and `LIMIT BREAK KILL(S)` are new stat names and are registered in
both fold layers. `FUSION REPEATER ACCURACY` needs no fold — percentages have no plural.

**Files.** `src/data/reference.ts`, `src/lib/scoreboard-extractor.ts`,
`public/heroes/D.Mon.png` (128×128), `src/data/stat-meta.ts`,
`src/data/hero-stat-catalog.ts`. **DB:** `hero_role_ref` + `hero_stats_normalised`.

### 2. `PLAYERS PROTECTED` — a new tank role tile

**Symptom.** Visible on every tank's breakdown screen; absent from `STAT_NORMALISE`, from
every format set, and from all 14 tank catalog entries.

**Root cause.** Not an extraction fault. Tank breakdowns captured **exactly** their expected
tile counts on 31 July — Winston 5, Zarya 6, Orisa 7, Sigma 8, Domina 8 — and Sigma and
Domina proved an eight-tile capture was possible. The tile simply did not exist yet; it
arrived between 31 July and 12 August.

**Fix.** Added to all 15 tanks and to the role-stat list on both Heroes pages. Nine tanks had
room and went +1; five were at the eight-tile ceiling and swapped out their ultimate tile.

⚠️ **The five retired tiles stay in `HERO_BREAKDOWN_ORDER` and `STAT_NORMALISE` on purpose.**
Historical matches hold their values and must stay readable.

**Files.** `src/data/hero-stat-catalog.ts`, `src/data/stat-meta.ts`,
`src/app/analytics/heroes/page.tsx`, `src/app/analytics/heroes/[name]/page.tsx`. **DB:**
`hero_stats_normalised`.

### 3. Role tiles were never folded in code

**Symptom.** Of 161 distinct stat names in `hero_stats`, 34 appear in more than one spelling.
Thirty-one are correctly folded. The three that are not are **exactly the foldable role
tiles**: `FINAL BLOW`/`FINAL BLOWS` (25/115 rows), `SOLO KILL`/`SOLO KILLS` (45/96),
`PLAYER SAVED`/`PLAYERS SAVED` (12/89).

**Root cause.** `STAT_NORMALISE` was generated from the per-hero stat list, and role tiles are
deliberately excluded from `HERO_BREAKDOWN_ORDER` — so they were never in the source. The
correlation is total in both directions.

⚠️ **Analytics were never wrong.** `hero_stats_normalised` folded all three correctly the
whole time; only the code map had drifted. The one live consequence was
`new-content-readiness.ts`, which folds raw OCR rather than view output and so reported role
tiles as unrecognised new stats on `/testing`.

**Fix.** Four pairs added, including `PLAYER(S) PROTECTED` pre-emptively. The game pluralises
on **value** — singular at exactly 1, plural otherwise including 0 — proven by a clean
partition: all 12 `PLAYER SAVED` rows sit at value 1 and none of the 89 plural rows do. OCR
also drops trailing characters independently, so both spellings are required regardless.

**Files.** `src/data/stat-meta.ts`, with a header warning that a regenerate will drop these
again.

### 4. The score overrode the VICTORY banner

**Symptom.** Test 1 (a win) stored as `DEFEAT`. Two of ten test matches affected — precisely
the two where banner and score disagreed.

**Root cause.** `image-processor.ts` re-derived the result from the score and used the banner
only as a fallback, inverting the rule `ocr-extractor.ts` documents and applies. It was a
**second implementation of the same rule**, and the copies disagreed.

The score cannot decide this: Test 1 is a VICTORY at 0-2 and Test 8 a DEFEAT at 0-2.

**Fix.** Deleted `resultFromScore()` and its call site. `ocrSummaryPage()` already resolves
banner-then-score internally, so the assignment is now a straight copy. The conflict flag
still fires for confirmation.

**Files.** `src/lib/image-processor.ts`.

### 5. ⭐ The scoreboard table is centred and its width varies

**Symptom.** Two faults that looked unrelated. Test 9's roles read **5-0-1 on both teams**
against a real 1-3-2 / 2-2-2, which role-filtered every ally slot against tanks only. And
6v6 portrait scores sat at 13.8–16.9% against 36–42% on 5v5, with **12 of 12 rows flagged
fragile** on two boards.

**Root cause — one cause, both faults.** The table is centred at x≈1919.5 on every board of
both formats, but its **width varies with content**, so the left edge moves by half the
change and every absolute x-coordinate drifts with it.

| | table width | left edge | drift |
|---|---|---|---|
| 5v5 (7 boards) | 1690–1699 | 1070–1074 | **4px** — invisible |
| 6v6 (3 boards) | 1462–1517 | 1161–1188 | **27px** — breaks two things at once |

The role-icon window clipped the DPS glyph's third bar, so `classifyRoleIcon` saw two bright
segments instead of three and returned `tank`. The portrait crop variants spanned 15px and
could not reach an origin 25px away.

⚠️ **Tests 8 and 10 had been "passing" by about one pixel.** Nothing was ever robust.

**Fix.** `detectTableEdges()` finds the table's extent on three sampled rows and takes the
median. All 6v6 x-coordinates — icon window, portrait origin, all four crop variants, and the
gamertag crops — are shifted by the measured delta from a calibration baseline.

**5v5 is deliberately NOT derived.** Its edge moves 4px, its constants are exact (portrait
origin measured 1130 on six of seven boards against a hardcoded 1130), and variant 1 wins
66/70 slots. Changing geometry there would risk the one format that demonstrably works.

**Verified:** all seven 5v5 boards came back **byte-identical** — same heroes, same scores to
one decimal, same fragile counts. That is guaranteed by construction, not by luck: the
resolver returns early unless the format is 6v6.

| | before | after |
|---|---|---|
| Test 8 | 16.9%, 12 fragile | **39.5%, 2 fragile** |
| Test 9 | 13.8%, 12 fragile | **29.6%, 7 fragile** |
| Test 10 | 38.8%, 3 fragile | **40.2%, 2 fragile** |
| Whole set | 43 fragile | **27 fragile** |

**Files.** `src/lib/types.ts`, `src/lib/scoreboard-extractor.ts`.

### 6. Catalog stat order is positional

**Symptom.** Ramattra returned 7/8 stats with `UNKNOWN_TILE_R3C2`, and its `PUMMEL ACCURACY`
tile was labelled `PUMMEL KILLS`.

**Root cause.** When a tile's label fails OCR, `breakdown-ocr` falls back to `catalog[index]`
by grid position. Echo's entry happens to be in true screen order so its tiles resolve
correctly; eight tank entries were not, so the recovery mechanism supplied the wrong name.
A mis-ordered entry **fails silently rather than loudly**.

**Fix.** Eight tank entries reordered to screen order, verified against screenshots, with a
header stating that the order is positional.

⚠️ **The other 44 heroes have not been verified.** The old ordering looks like a consistent
rotation, so more entries are likely affected. Latent — it only bites on an OCR failure.

**Files.** `src/data/hero-stat-catalog.ts`.

### 7. Matchups defaulted to All Time

**Symptom.** With Season 4 created, Matchups became the only season-aware surface still
opening on pooled seasons. Logged in v1.1.0 Phase 2 as "revisit when Season 4 starts".

**Fix.** Seeds the current season once via a `seasonDefaulted` ref, matching every other
page. The seeding is guarded on a **successful** seasons read, not just the ref — the read is
deliberately non-fatal, and seeding from a failed one would silently mean All Time forever
with the ref blocking any correction.

**Files.** `src/app/analytics/matchups/page.tsx`.

### 8. Two hypotheses put under watch

Both of these are claims about how the *game* behaves, not about our code, so they are
monitored rather than assumed.

**Tile-ceiling check.** Every third time one of the five affected tanks appears on a
breakdown, `/process` asks whether the retired tile has come back. **Every sighting is
logged, including the ones not asked about** — a season of "still gone" means nothing without
the number of chances it had to be otherwise, and the sighting count also drives the cadence.

**Table geometry.** Every scoreboard logs its measured left edge and width, **both formats**.
5v5 is logged precisely because it is *not* derived: leaving it on hardcoded constants is only
defensible if drift would be noticed. The Issue Log flags 5v5 red past a 15px spread and names
the fix.

Neither is an error event — both are excluded from error-rate and signal-precision maths. A
fact about the game is not a pipeline mistake.

**Files.** `src/lib/beta-issue-log.ts`, `src/app/review/HeroAuditPanel.tsx`,
`src/app/process/page.tsx`, `src/app/issue-log/page.tsx`, `src/data/hero-stat-catalog.ts`.

### What this patch keeps teaching

Every fault above hid the same way: **two things agreed, and one of them was incapable of
disagreeing.** Catalog tile counts matched captured counts — both predated the new tile. Code
and database "mirrored" each other — the correct side was the only one being read. Two 6v6
boards passed the role-icon check — by one pixel. The 5v5 constants look verified — they are
verified, but only against boards whose width never moved.

*Where two things agree, ask whether they were capable of disagreeing.*

---

## v1.1.0 — released 11 August 2026

The "mega patch". Six phases, one push. A redesigned feel-question set on new columns, a
filter system converted from scalars to arrays, three-state leaver tracking, post-match
standout picks, and a correctness pass. **DB change? Yes** — one enum, one new table, six new
columns across three tables, and two view rebuilds.

⚠️ **The version-2 question set only applies from Season 4 onward.** Season 3 and earlier
read the version-1 set. `seasons.question_scale_version` is the sole authority for which set a
match belongs to, and **the two scales are never pooled or averaged together.**

| # | Area | Symptom | Fix | DB change? |
|---|------|---------|-----|-----------|
| 1 | Feel questions | Tempo/coordination unanswerable for multi-round games and being clicked through without thought | Both retired; five-question v2 set on NEW columns, old enums frozen | **Yes** (3 columns + version flag) |
| 2 | Leaver tracking | A leaver who reconnects was indistinguishable from one who never returned | `leaver_type` enum, three states; permanent discards the scoreboard, returned keeps it | **Yes** (enum + 2 columns) |
| 3 | Standout picks | No record of which hero stood out in a match | `match_standouts` child table + post-match slot picks + Matchups tiles | **Yes** (new table) |
| 4 | Filters | Mode/map/hero were single-select with three different "no filter" sentinels | Converted to arrays; empty array = no filter, everywhere; season became a dropdown | No |
| 5 | Match detail | A version-2 match showed NO fun rating and none of the new fields | Renders one question set chosen by the match's SEASON, as labels not numbers | No |
| 6 | `heroes_played` | Nine matches returned `{NULL}` — a one-element array containing null | `array_remove` on the view's aggregate; they now return `{}` | **Yes** (view) |
| 7 | Correctness pass | Combat chart vanished on a hero filter; Outcomes side panel permanently blank; Time drew zero-width bars for never-played buckets | Four independent fixes | No |
| 8 | Cosmetic pass | Stale menu copy promising retired fields; raw DB enum rendered to the user; minutes shown where h:mm was used elsewhere | Six files | No |

### 1. Feel questions — retired two, moved the rest to new columns

**Symptom.** `team_tempo` and `team_coordination` (and their enemy twins) were unanswerable by
construction and contaminated in practice. A control match can have a contested first point, a
collapse, and another collapse; any single value for a multi-round game is a lie. The owner
also reports clicking through these questions quickly without thought when not in the mood — a
rushed field is worthless regardless of how healthy its histogram looks.

**Root cause.** Not a bug. A question-design error carried since the original schema.

**Fix.** Tempo and coordination retired outright. The surviving set is five questions plus two
slot picks: `matchup_feel` (5-point, midpoint kept, closeness folded in), `performance_rating`
(5-point), `fun_rating_6` (**6-point, no midpoint, behaviourally anchored** — the missing
middle is deliberate, to remove the lazy centre answer).

⚠️ **NEW COLUMNS, NOT ALTERED ENUMS.** Old and new answers are never compared or pooled, so
there was no reason to mutate the existing types. `match_feel`, `performance_feel`,
`fun_rating`, `tilt_mood`, `team_tempo`, `team_coordination` and the enemy twins are **frozen
as-is**. `seasons.question_scale_version` decides which set a match reads. The Builder
**refuses** any v1×v2 variable pairing via `VarDef.scaleVersion` in `pairValidity`.

**Files.** `src/lib/types.ts`, `src/app/review/*`, `src/app/matches/new/page.tsx`
(`StarRating` → `ScaleSelect`), `feel-lib.ts`, `builder-lib.ts`. **DB:**
`seasons.question_scale_version` (smallint, default 1), plus three columns on `matches`.

### 2. Leaver tracking — three states, not a boolean

**Symptom.** `team_leaver` / `enemy_leaver` were booleans. A player who left and **reconnected**
was recorded identically to one who never came back — but the two cases have opposite
implications for the scoreboard, which is valid in one and meaningless in the other.

**Fix.** A `leaver_type` enum with three states. **Permanent leavers discard the scoreboard;
returned leavers keep it and are filtered at read time.** Both booleans retained and seeded
from the new columns, so nothing downstream broke on the day.

**Files.** `src/lib/types.ts`, `alpha.ts`, the review flow, Home's leaver grids. **DB:** the
`leaver_type` enum, `matches.team_leaver_type` / `enemy_leaver_type`, plus `team_thrower` /
`enemy_thrower`; `combat_facts` rebuilt to expose them.

**Verified live 9 Aug 2026:** 192 non-alpha matches · 13 permanent leavers (8 enemy, 4 team,
1 both) · 4 thrower matches, 3 carrying no leaver · 0 returned leavers, since none can exist
until new matches are played. Every boolean matches its seeded `leaver_type`.

### 3. Standout picks — capture, storage, and ten tiles

**Fix.** A `match_standouts` child table plus post-match slot picks, surfaced as ten tiles on
the Matchups page. Self-picks are excluded and null `hero_name` rows are skipped.

⚠️ **The denominator is the whole argument.** A standout rate is only meaningful against the
number of matches where that hero *could* have been picked, not against total matches.

**Files.** review flow, `matchups/page.tsx`. **DB:** new `match_standouts` table.

⚠️ **Both guards are synthetic-tested only** — the table is empty and neither has seen a real
slot→hero resolution. First thing to eyeball in beta. (Open item #26.)

### 4. Filter system — scalars to arrays

**Symptom.** Mode, map and hero were single-select, with **three different sentinels for "no
filter"** (`''` for map and hero, `'all'` for mode) that had to be translated between
surfaces. That mismatch caused the v1.0.1 empty-page bug.

**Fix.** `AnalyticsFilterState` converted to arrays. **The fields were RENAMED deliberately**
(`mode`→`modes`, `map`→`maps`, `hero`→`heroes`) so every consumer became a hard compile error
rather than a silent type change. **Empty array = no filter, everywhere** — there is no longer
anything to translate. Queue stays single-select, since 5v5 and 6v6 never mix. Season became a
dropdown; mode/map/hero became multi-select with type-ahead.

**Files.** NEW `src/components/MultiSelect.tsx` (separate from `Select.tsx`, which is
untouched); `AnalyticsFilters.tsx`; `matchups-lib.ts`; `hero-pairings-lib.ts`; `builder-lib.ts`;
the outcomes, time, feel, combat, heroes and hero-detail pages. **DELETED:** the duplicate
`src/lib/builder-lib.ts`, plus both dead filter-application paths (`applyMatchQueryFilters`,
`applyFilters`). No SQL, no DB.

### 5. Match detail — the real version-2 blank

**Symptom.** A version-2 match showed **no fun rating at all**, and `matchup_feel` /
`performance_rating` appeared nowhere.

**Root cause.** The Summary block rendered only `fun_rating`, as five stars, behind an
`!= null` guard. A version-2 match has `fun_rating` null and `fun_rating_6` set, so the guard
failed and the row **vanished with no indication anything was missing**.

⚠️ **The spec blamed `match_overview` for this and was wrong.** Nothing read those columns off
the view — Home selects `id, result, map, played_at`; `/matches` selects `id, heroes_played`.
Confirmed by grep across `src/` before changing anything.

**Fix.** Renders exactly one question set, chosen by the match's **season** via
`scaleVersionOf()` — never by sniffing which columns are populated. Values render as **labels,
not numbers**: "4" means different things on a 5-point and a 6-point scale, and a single match
has no axis for the number to order against. **Version-1 fun keeps its five stars**, because
that scale was *captured* as stars; version 2 drops them deliberately.

**Files.** `src/app/matches/[id]/page.tsx`, `feel-lib.ts`. No SQL, no DB.

### 6. `heroes_played` returned `{NULL}` for nine matches

**Symptom.** Nine matches returned a one-element array containing null rather than an empty
array.

**Root cause.** `array_agg` over a LEFT JOIN produces one phantom null element when the joined
side has no rows. Those nine matches have zero `hero_performances` rows.

**Fix.** `array_remove(array_agg(...), NULL)` in the `match_overview` definition. The nine now
return `{}`. Verified: `null_array_matches = 0`, `empty_array_matches = 9`, `total_rows = 192`
unchanged, and a cardinality spot-check confirming no match with a breakdown lost a hero.

⚠️ **This migration carried Phase 4's with it, because Phase 4's had never gone live.**
`pg_get_viewdef` returned the pre-Phase-4 definition — 15 columns, none of the four the
documents recorded as applied 9 Aug. **A documented migration is not an applied one.** The
cause could not be determined and was not guessed at (open item #27).

⚠️ **Why the nine have no breakdown is still undetermined.** All nine fall between 25 and 31
July 2026 and seven are 6v6 — a six-day episode, not a background rate. `/process` now warns.

**DB:** `match_overview` rebuilt (the four appended columns plus the `array_remove`).

### 7. Correctness pass

Four independent fixes, no DB impact:

- **Combat** — `drillDimension` read `if (heroActive) return 'none'`, so picking a hero removed
  the damage/healing/mitigation chart entirely, even though "how does my Ana healing share vary
  by mode" is exactly what it could still answer. Now drills by the coarsest unfiltered
  dimension.
- **Outcomes** — the attack/defence panel rendered permanently blank; now hidden when no
  selected mode can have a starting side.
- **Time** — zero-game buckets drew a zero-width bar labelled "—" with n=0, which reads as "0%
  win rate here" rather than "no data here". Now dropped before render.
- **Home `topBy`** — recorded as outstanding; **had already shipped.** Verified by reading the
  code. No change.

### 8. Cosmetic pass

- **Menu copy** promised "tilt" and "tempo" — fields this patch retires. Reworded to describe
  what the page *asks about*, so it survives the next question change. ⚠️ Blurbs must never
  name a version-specific feel field.
- **A raw database enum was being rendered to the user.** The hero detail page's last-5 rows
  interpolated `starting_side` directly, which would have printed lowercase `defense` on the
  first Season 4 escort game. Fixed with a `sideLabel()` helper. ⚠️ **The column stays
  US-spelled** (`'attack'` / `'defense'`) — it is matched by `.eq()` in queries. Only rendered
  strings are British.
- **Session duration** on the Time month chart now reads h:mm, matching the stat card and
  tooltip that already did. Legend and tooltip series names unified.
- **Result mix** legend now carries `n=`.
- **Confidence legend** added to the Hero Pairings grid — the last surface applying the
  dimming convention without stating it.

**Files.** `AnalyticsNav.tsx`, `analytics/heroes/[name]/page.tsx`, `analytics/time/page.tsx`,
`analytics/heroes-overview/page.tsx`, `analytics/outcomes/page.tsx`, `matches/[id]/page.tsx`.
No SQL, no DB.

### Deploy checklist — v1.1.0

**All migrations are already applied** (Phase 1 on 9 Aug, `match_overview` on 10 Aug). Verify
before shipping code rather than after:

```sql
-- Phase 1 schema — expect all four present.
select
  (select count(*) from information_schema.columns
    where table_name='seasons' and column_name='question_scale_version')     as has_version,
  (select count(*) from information_schema.columns
    where table_name='matches' and column_name='team_leaver_type')           as has_leaver_type,
  (select count(*) from information_schema.columns
    where table_name='matches' and column_name='matchup_feel')               as has_v2_feel,
  (select count(*) from information_schema.tables
    where table_name='match_standouts')                                      as has_standouts;

-- match_overview — expect 0 / 9 / 192.
select
  count(*) filter (where heroes_played = array[null]::text[])  as null_array_matches,
  count(*) filter (where cardinality(heroes_played) = 0)       as empty_array_matches,
  count(*)                                                     as total_rows
from match_overview;
```

⚠️ **If the second query returns a non-zero `null_array_matches`, STOP** — the view has
reverted, and that has happened silently once already in this patch.

Files to ship: the full v1.1.0 working tree. This is a single push covering six phases; there
is no partial-deploy path, and the phases were verified in sequence on localhost rather than
staged to production.

Docs updated:
- `Supabase Map.md` — Parts F/H/I; the `leaver_type` enum, `match_standouts`, the v2 feel
  columns, `question_scale_version`, the `combat_facts` and `match_overview` rebuilds, and the
  correction recording that Phase 4's migration was never live.
- `FILE-MAP.md` — bumped to v1.1.0; entries for `MultiSelect`, the filter conversion, both
  standouts guards, the six cosmetic files, and a correction to the dimming convention (the
  Heroes list is a hard gate, not a dim).
- `PATCH-SPEC-v1_1_0.md` — phases 0–6 closed, Phase 7 deferred out of the release.
- Session logs for 8–9, 9, 10 and 11 August.

**Post-deploy:** hard-refresh and unregister the service worker. Then, in order:

1. **Create Season 4 through Settings, NOT SQL** — this is the single most consequential manual
   step in the release. Created by hand it will not be stamped `question_scale_version = 2`,
   and the v1/v2 separation breaks silently. **The badge should read Q2.**
2. Process one real match and confirm the version-2 questions appear, the standout slot picks
   save, and the match detail page renders labels rather than numbers.
3. Check any escort or hybrid game shows **"Started on: Attack/Defence"** on both the match
   detail and hero detail pages — see the watch note below.

**Watch after deploy.**

⚠️ **Four surfaces will be legitimately EMPTY until version-2 data exists**, and none of them
are broken: the returned-leaver row and column on Home's grids, the three v2 Builder variables,
and both standouts rows. The first real match through the pipeline is the actual test.

⚠️ **Two fixes in this patch have NEVER RENDERED.** `starting_side` is null on all 192
historical matches, so the attack/defence displays on `matches/[id]` and `heroes/[name]` are
code-complete but have never been seen on screen. The first Season 4 escort or hybrid game is
their first execution. **Where the code and the data agree, check whether the data is capable
of disagreeing** — absence of a symptom proves nothing where the column is empty by
construction.

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
