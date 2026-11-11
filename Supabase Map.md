# Supabase Map — Overwatch Ranked Tracker (v1.1.0)

> **⚠️ A DOCUMENTED MIGRATION IS NOT AN APPLIED ONE. `pg_get_viewdef` BEFORE EDITING ANY
> VIEW, EVERY TIME.** This is a standing rule, not advice. A `match_overview` migration
> recorded in this file as "applied" had in fact never gone live, and was only caught
> because a later migration opened by dumping the live definition first. Postgres keeps no
> history of view definitions, so a silent revert leaves no trace. **Rebuild view statements
> from the live `pg_get_viewdef` output, never from the SQL written in this file.**
>
> **⚠️ VERIFY, DO NOT INFER.** Where several verification queries are given for one change,
> run all of them — they are usually not interchangeable, and one passing does not imply the
> others would (see Part I, where the cardinality check cannot see the rows the `{NULL}`
> count exists to find).

> **What this is.** A complete map of the app's database: every table, every view, what
> each one stores or computes, how they connect, and — most importantly — **which ones
> hardcode hero / map / stat names** (so you know what to update when a new season
> adds content). Verified live against the database (not from old notes) on the date
> this file was written, except where a line is explicitly marked *(from handover
> notes)*.
>
> **One DB for local + live.** Supabase is a single shared database used by both your
> local testing and the live site. Testing locally writes to the same place as live.
> Read-only describe-queries (like the ones used to build this) are always safe.

---

## ⭐ THE HERO / MAP / STAT DEPENDENCY SUMMARY (read this first)

When a new season adds content, **almost everything in the database updates itself**
as you play — the analytics views group your match data dynamically. There are only
**three** places anything is hardcoded, and only heroes/stats are affected:

| New thing | Needs a database change? | What |
|---|---|---|
| **New map** | ❌ **No** | `map_analytics` and every map surface group dynamically from your matches. Just play on it; it appears. |
| **New hero** | ✅ **Yes — one view** | `hero_role_ref` hardcodes the 53 heroes→role list. Add the hero here or Matchups won't know its role. |
| **New STAT name** (a stat no existing hero has) | ✅ **Yes — one view** | `hero_stats_normalised` hardcodes 125 stat-name fold rules. Add the new stat or its value won't normalise in the DB. |

Everything else (win rates, play time, E/A/D, damage shares, breakdown aggregates,
season splits, role splits, map splits) is **dynamic** — no DB edit needed.

> These two SQL updates are now written into the **New Season Runbook** as required
> steps. They are `CREATE OR REPLACE VIEW` statements — safe and reversible, they
> change no data.

---

## How the data flows (the big picture)

```
  PHONE (/upload)                LAPTOP (/process)                 ANALYTICS PAGES
  collects answers     ──▶       processMatchPhotos()      ──▶     read VIEWS
  + screenshots                  + confirmation                    (never raw tables
  → Storage pending/             → writes BASE TABLES               for analytics)
                                   (matches, hero_performances,
                                    hero_stats, scoreboard_players)
```

- **Base tables** = where your real data lives (you write to these via processing).
- **Views** = saved queries that compute facts/averages on top of the base tables.
  Pages read views, then do light filtering/averaging in JavaScript.
- You never hand-edit table rows for a new hero/map — heroes and maps live in the
  app's *code* (`reference.ts`), and match data arrives through processing.

> **One documented exception to "never raw tables for analytics":** the **Home** page
> reads the `matches` table directly (not a view) for its all-time/season aggregates. It
> does so through `matchQuery()` (`src/lib/alpha.ts`), which adds `.eq('is_alpha', false)`
> off-localhost — so the alpha rule is still applied, the same way the plain views apply
> it. (Reading `matches` raw *without* `matchQuery` is exactly what let alpha test data
> leak onto the live Home page before v1.0.0; the fix was to route the query through
> `matchQuery`.)

---

# PART A — BASE TABLES (where data is stored)

There are **12 tables**. All have Row-Level Security **ON** with a permissive
"authenticated full access" policy (the builder tables also allow anon/public, since
saved charts aren't sensitive). Below, ⚙️ marks columns written by the processing
pipeline.

### `matches`
> **(v1.0.2) REPAIRED 3 Aug 2026.** `role_played` was stuck on `'dps'`, firing
> `role_mismatch` on 25 of 29 6v6 matches and making every role-split analytic read a
> constant; it was repopulated from `roles_played` for single-role matches.
> ⚠️ `role_played` is an ENUM (`role_type`) while `scoreboard_players.role` is `text` —
> comparing them directly raises `operator does not exist: role_type = text`. Cast BOTH
> sides to `::text`. Introspect types before writing DDL; this document is for
> orientation, not schema truth.
 — one row per game *(the spine of everything)*
The central record of each match. Key columns (live-verified):
- **Identity/result:** `id`, `played_at` (the OCR'd match timestamp — drives seasons,
  sessions, streaks), `season_id` → `seasons.id`, `map`, `game_mode`, `result`
  (victory/defeat/draw), `score`, `role_played`, `roles_played[]` (array, for 6v6
  multi-role), `match_format` (`'5v5'`/`'6v6'`, CHECK-constrained), `starting_side`,
  `game_length_seconds`.
- **Totals:** `total_eliminations/assists/deaths`, `elims/assists/deaths_per_10_min`.
- **Team comp:** `ally_team_comp`, `enemy_team_comp` — both **`text`** (nullable; the
  #6 retype — they are NOT arrays in the DB).
- **Feel fields:** `match_feel`, `performance_feel`, `fun_rating` (1–5, CHECK),
  `personal_thoughts`, `tilt_mood`, `team_tempo`/`enemy_tempo`,
  `team_coordination`/`enemy_coordination`, `team_leaver`/`enemy_leaver` (bool,
  default false — **the leaver feature reuses these**), `team_thrower`/`enemy_thrower`.
- **Flag:** `is_alpha` (bool, NOT NULL, default false — localhost writes set true).
- ⚠️ `notable_events` is **gone** from the live table (confirmed: a gap at column 19
  where it used to be — removed in #13d). Don't reference it.
- **No hero/map hardcoding** — `map` and heroes are just text values from your games.

> **⭐ ENUM TYPES (live-verified v1.1.0).** Five columns are Postgres enums
> (`USER-DEFINED`), not text — changing their value sets means altering the type:
> - `result` → `victory` / `defeat` / `draw`
> - `role_played` → tank / dps / support
> - `starting_side` → **`attack` / `defense`** (US spelling in the DB; any UI showing
>   "Defence" is a label only, and the Outcomes page comparison is CORRECT as written).
>   ⚠️ **(v1.1.0) DO NOT "TIDY" THIS COLUMN TO MATCH THE UI.** Every consumer matches the
>   ENUM — `.eq('starting_side', 'defense')` in `heroes/[name]`'s `buildQuery`, the option
>   `value` on its Starting Side control, and the ternary on `matches/[id]`. Renaming the
>   value to the British spelling breaks the hero detail page's SQL filter **silently**: the
>   query returns zero rows rather than erroring. The column and the rendered label are
>   deliberately allowed to differ.
> - `match_feel` → `stomped_them` / `close_game` / `got_stomped`
> - `performance_feel` → `carried` / `did_my_job` / `struggled`
>
> `tilt_mood`, `team_tempo`, `team_coordination` are plain **text**. `fun_rating` is a
> **smallint**. So retiring or rescaling those four costs no type surgery.

> **⚠️ `starting_side` IS NULL ON ALL 192 MATCHES (v1.1.0 finding).** 61 escort + 70 hybrid
> matches should carry a side; none do. **Not a page bug and not a spelling bug** — the enum
> matches what the Outcomes page compares against, the phone wrote the value into
> `metadata.json` correctly, and `saveMatch` read it back correctly. The cause was a **stale
> closure** in `upload/page.tsx`: the `confirm_side` handler called `setStartingSide(side)` then
> invoked `commitUpload()` from a timeout, but that `commitUpload` was the function object from
> the render in which the handler was created, closing over `startingSide` as null. 100% failure
> rate.
>
> **No backfill is possible** — the answers were never persisted anywhere. Attack/defence data
> begins from the fix onward. Treat all pre-fix nulls as MISSING; after the fix, null means
> "Not sure".

> **📋 PHASE 1 PLAN — the feel questions are being rebuilt. Use NEW COLUMNS, not altered enums.**
> Decision recorded: old and new answers are **never compared or pooled**, so there is no reason
> to mutate the existing enums. Freeze `match_feel`, `performance_feel`, `fun_rating`,
> `tilt_mood`, `team_tempo`, `team_coordination` (and the enemy twins) as-is; add new columns
> alongside. Season 3 reads the old set, Season 4 onward reads the new. The scale version lives
> on the **`seasons`** table (see that entry), so a chart asks the season what scale it used
> rather than hardcoding a season number.
>
> Being retired and NOT replaced: `team_tempo`/`enemy_tempo`,
> `team_coordination`/`enemy_coordination` (unanswerable for multi-round games, and the existing
> answers were entered without thought), and `tilt_mood` (96% of answers in 3 of 5 values,
> `hyped` used once ever; and the question is unanswerable because it depends on whether the
> session is over, which isn't known at the time of asking). Tilt carry-over will instead be
> DERIVED from `played_at` via `time-lib`'s session/streak helpers.
>
> Being added: three-state leaver type columns (`none`/`left`/`returned`, with the existing
> booleans kept in sync), and a `match_standouts` child table for the impressed-ally /
> struggled-enemy slot picks.

### `hero_performances` — per-hero breakdown rows for a match
One row per hero you played in a match. `id`, `match_id` → `matches.id`, `hero_name`,
`percent_played`, `play_time_seconds`, `eliminations`, `assists`, `deaths`,
`display_order` (1–3, CHECK). `hero_name` is free text from extraction — a new hero
just shows up here once played.

> **⚠️ (v1.1.0 finding, CORRECTED IN PHASE 4) 9 MATCHES HAVE ZERO ROWS HERE — a 4.7%
> app-wide blind spot.** Match ids **222, 262, 266, 268, 272, 280, 281, 288, 289** have no
> `hero_performances` rows at all, despite normal game lengths (394–986s) and valid
> scoreboards — **all nine carry a COMPLETE scoreboard** (10 rows for 5v5, 12 for 6v6) and
> **none has a leaver**, so summary and scoreboard extraction both succeeded and only the
> breakdown is missing.
> ⚠️ **289 (Rialto, 6v6, 31 Jul 01:31) was missing from the original list of 8**, which is
> why the old figure read 4.2%. The COUNT was never the interesting part: **all nine fall
> between 25 and 31 July 2026** and **seven of the nine are 6v6**. It is a six-day episode,
> not a steady rate. In that window 6v6 lost breakdowns at 24% (7 of 29) against 5v5's 2.9%
> (2 of 70).
> **CAUSE UNDETERMINED — do not record a guess as a finding.** The pre-v1.0.2 OpenCV worker
> leak fits (all nine predate the 4 Aug fix; all nine failed only AFTER scoreboard
> extraction) but that leak was silent by construction — the throw was caught and `orb` set
> to 0 — so a crash and never-uploaded screenshots leave identical evidence.
> `beta_issue_log` cannot discriminate either (it has no `processing_error` rows in two
> months, which is what BOTH hypotheses predict, and it cannot be joined to matches anyway).
> **Phase 4 response: `/process` now WARNS at review time** when a match is about to save
> with no hero rows. The nine remain permanently thin — re-processing is not viable. Every hero-grain surface reads
> this table or a view over it — **Hero Analytics, the Combat page** (`combat_facts` ←
> `hero_match_facts`) **and Home's Season Breakdown all silently omit these matches.** Only
> Matchups sees them, via the `matchup_user` scoreboard fallback.
>
> Verified NOT caused by null `play_time_seconds` (327 rows, 0 nulls) and NOT by the three-hero
> summary cap. Likely uploads without breakdown screenshots. **Not yet diagnosed** — carried into
> the Phase 4 app audit. Consider warning at `/process` when a non-leaver match saves with zero
> hero rows.
>
> Separately: `display_order` is capped at 3 by CHECK because **the summary screen only ever
> shows three heroes**. A fourth hero played in a match is never recorded here at all — a hard
> ceiling on every hero-grain figure in the app.

### `hero_stats` — per-stat breakdown values
One row per stat tile on a hero's breakdown screen. `id`,
`hero_performance_id` → `hero_performances.id`, `stat_name` (raw OCR text),
`stat_value` (**text**), `avg_per_10_min` (**text**, the ~60%-reliable raw OCR
per-10 — not trusted). The raw `stat_name` here is what `hero_stats_normalised`
folds to canonical form.

### `scoreboard_players`
> **(v1.0.2) REPAIRED 3 Aug 2026.** `hero_name` and `role` were corrected from ground
> truth on all 324 slots across the 27 6v6 beta matches with a scoreboard (71 were wrong
> — 21.9%). Numeric stat columns were NOT touched: all 1,944 cells were verified correct.
> Everything downstream (`matchup_pairs`, `matchup_single_agg`, `matchup_team_sets`,
> `match_team_damage`, `user_scoreboard_row`) is a VIEW, so the fix propagated
> automatically. `matches` was NOT re-processed — feel and star ratings are subjective
> and unrecoverable.
> Mapping used: `match_id = 263 + test_number`, valid ONLY with `not m.is_alpha` — the
> table holds 38 6v6 matches, 9 of them alpha (19 May – 1 Jun), which sort first and
> shift every index by nine.
 — the 10/12-player scoreboard
One row per player slot in a match (NOT for leaver games — those write zero rows).
`id`, `match_id`, `slot` (1–12, CHECK), `team` (ally/enemy, CHECK), `hero_name`,
`role` (tank/dps/support or null, CHECK), `is_user`, `user_match_method`
(ocr_auto/ocr_confirmed/manual_select/hero_match, CHECK), and stats `eliminations`,
`assists`, `deaths`, `damage`, `healing`, `mitigation`. ⚠️ **Other players' gamertags
are never stored** — players are identified by slot + role only.

### `seasons`
`id`, `name`, `start_date`, `end_date` (CHECK: end > start), `created_at`. Matches
auto-assign by `played_at`. Adding a season is done in Settings, not here.

> **📋 PHASE 1 — a question-scale version column belongs HERE, not on `matches`.**
> Agreed rule: **a feel/question scale holds for an entire season and changes only at a
> boundary.** One column on this table, set when the season is created in Settings. Charts then
> ask the season what scale it used, instead of hardcoding "season 3 onwards" — which breaks
> silently the next time the questions change, and they are expected to keep changing.
> A per-match stamp was considered and rejected as redundant given the season-locked practice.

### `user_settings` — single-user preferences
`id`, `gamertag`, `default_role` (unused), `theme_mode`
(`'system'`/`'light'`/`'dark'`, CHECK — v40 theme), timestamps.

**Excluded-games switches (v1.1.0)** — `show_permanent_leavers`,
`show_returned_leavers`, `show_throwers`, all `bool NOT NULL DEFAULT false`.
Three switches rather than one because they cover three different kinds of bad
game: a permanent leaver has no scoreboard at all, a returned leaver has a
complete scoreboard with skewed numbers, and a thrower has a completely valid
scoreboard that is simply annoying. That last one is why thrower exclusion is a
read-side PREFERENCE and never a write-time filter.

`show_leaver_games` (bool, default false — v34) is **DEPRECATED**, not dropped.
It meant "show any leaver game" and seeded BOTH new leaver columns on migration.
Retained for rollback safety and carries a `comment on column` saying so; drop it
once nothing references it. Nothing in `src/` reads it as of v1.1.0.

⚠️ **Write these as a fixed literal shape.** The Supabase client rejects both a
computed key (`{ [col]: v }` — an index signature) and a per-key ternary (a union
of shapes, which TS pins to the first branch). `setExclusionPref` writes all
three columns from its cache in one literal for this reason; both alternatives
were tried and both failed the build.

### `match_images`
`id`, `match_id`, `image_type`, `storage_path`, `hero_name` (nullable), `created_at`.
⚠️ **Verified empty in practice** — nothing in the pipeline writes to it; image
retention is a future design decision, not built. Leave alone.

### `beta_issue_log` — append-only diagnostics (6f)
> **⚠️⚠️ (v1.1.0 Phase 4) `match_id` IS NOT A MATCH ID. THIS TABLE CANNOT BE JOINED TO
> `matches`. AT ALL.**
> The column is **`text`**, not an integer (a join without a cast fails with
> *"operator does not exist: text >= integer"*), and **all 806 rows are 13-digit
> millisecond epochs** — the client-side UPLOAD BATCH id. Not one row holds a
> `matches.id`. Verified by `select length(match_id), count(*) ... group by 1`: a single
> group, length 13.
> **This is structural, not an oversight.** `/process` calls `logHeroAudit` and
> `logMatchSummary` with `batch.batchId` BEFORE `saveMatch` runs, so the real match id does
> not exist yet. Fixing it means logging after the save — which trades
> diagnostics-on-failure (the case you most want logged) for joinability.
> **Consequence:** two months of per-slot diagnostics that can show something went wrong but
> never WHICH GAME. This is why the 9 zero-hero-row matches could not be diagnosed.
> Coverage: 806 rows, 1 Jun – 31 Jul 2026. Events: `confirmed_correct` 584,
> `match_summary` 203, `corrected` 15, `region_mismatch` 4, **`processing_error` 0**.
> ⚠️ Zero `processing_error` rows does NOT clear the OpenCV-leak hypothesis — that leak
> caught its own throw and substituted `orb = 0`, so it would log nothing either way.

`id`, `created_at`, `match_id`, `event`, `field`, `field_detail`, `signal`,
`read_value`, `corrected_value`, `confidence`, `format`, `questions_asked`,
`auto_pass_fields`, **`slot`, `margin`, `runner_up`, `orb_applied` (v1.0.2)**.
The `event` column has a CHECK allowing
`confirmed_correct`/`corrected`/`region_mismatch`/`unrecognized`/`match_summary`/`processing_error`.
> ✅ **Resolves the handover's "#10 CHECK-constraint caveat":** `field` and `signal`
> are plain unconstrained `text` — there is **no** CHECK on them, so logging
> `field:'map'` / `signal:'map_detect_fail'` cannot 400 on a constraint. That caveat
> can be closed.
> **(v1.0.0) Live confirmation:** the result cross-check now logs
> `field:'result'` / `signal:'result_conflict'` (via `logResultConflict`) — a brand-new
> field+signal pair added with **no** schema change, exactly because these columns are
> unconstrained text. It reuses an existing `event` value (`corrected` when the result
> changed, else `confirmed_correct`), since `event` *is* CHECK-constrained to the 6 types
> above — so no new event type was introduced.
>
> **(v1.0.2) Hero audit — four new nullable columns.** Beta confirmation is sunset and
> replaced by a per-slot hero audit, which writes **one row per scoreboard slot** rather
> than one per question. That is a different GRAIN, and the existing columns had nowhere
> to put it, so `slot int`, `margin numeric`, `runner_up text` and `orb_applied boolean`
> were added — all nullable, so every existing row and writer is unaffected. `event` is
> NOT changed: the audit reuses `confirmed_correct` / `corrected`.
>
> `orb_applied` is the one that matters. The matcher scores on TWO different formulas —
> Pass 1 is `0.6*structural + 0.4*colour`, Pass 2 is `0.5*orb + 0.3*structural +
> 0.2*colour` — so a `confidence` of 0.36 means different things depending on which ran.
> Without the flag a season of scores is an unpoolable mixture, and that is precisely
> what made an OpenCV worker heap leak invisible for four full test runs. Never pool
> `confidence` or `margin` across the two scales.
>
> ⚠️ `corrected_value` is now written on EVERY audit row, not just corrections — a
> confirmed row's value is the TRUTH LABEL. Omitting it would discard the negative
> examples that make an error rate computable. At ~400 matches a season this yields
> ~4,800 labelled slots (the manual ground-truth exercise produced 324).
>
> ⚠️ `signal` for audit rows is `hero_audit`; `field` is `hero_id`. Retired signals
> (`avg_crosscheck_fail`, `map_detect_fail`, `result_conflict`, `date_ocr_fail`,
> `vote_split`, `low_hero_conf`, `phase_disagreement`, `low_user_margin`,
> `sampled_summary`, `unrecognized`) are still present in HISTORICAL rows and should be
> excluded when analysing current accuracy.

### `builder_saved_charts` / `builder_chart_views` / `builder2_saved_charts` / `builder2_chart_views`
Saved-chart persistence for the two builders (the generic builder and the dual-axis
"Free" builder). Linked by `config_key`. The `builder2_*` set uses `cell_measure`
where `builder_*` uses `measure`. (These are the #13c "saved-charts live round-trip"
tables — code is column-consistent; a live Network-tab check is still parked.)

---

# PART B — VIEWS (computed analytics layers)

There are **28 views**. **All views have RLS off** (they inherit access from the base
tables they read). The two **hardcoded** ones are flagged ⭐. The naming pattern
`X` vs `X_with_alpha`: the plain view **excludes alpha** games (what live users see);
the `_with_alpha` twin **keeps** them (localhost only).

## ⭐ The two hardcoded views (update for new content)

### ⭐ `hero_role_history` — HARDCODED hero → role over time  *(new in v1.2.0, Season 5 SQL)*
`hero_name`, `role`, `valid_from`, `valid_to` — `[from, to)` on the UTC calendar date of
`matches.played_at`, `NULL` = open-ended. One row per hero per role it has held; Sombra has
two (`dps` until 2026-10-06, `support` from it). Mirrors `HEROES[].previously` in
`src/data/reference.ts`. **`matchup_rows` and `matchup_user` join THIS view, by game date**
(was `hero_role_ref`). A new hero goes in both role views — the `/testing` panel's
"COPY hero role SQL" regenerates them together.

### ⭐ `hero_role_ref` — HARDCODED hero → CURRENT role list  *(54 heroes after the Season 5 SQL)*
> **(v1.2.0)** Still one row per hero, current roles only (Sombra = support). After
> the Season 5 SQL nothing in the matchup chain reads it; it is kept, one-row-per-hero, so any
> other consumer can never double-count a hero that changed role.

A standalone lookup built from an inlined `VALUES` table:
`('D.Va','tank'), ('Doomfist','tank'), … ('D.Mon','tank')` — all 53 heroes.
Columns: `hero_name`, `role`. New entries are APPENDED to the end of the `VALUES` list
(`Shion`, then `D.Mon` in v1.1.1); the list is not alphabetical and order is irrelevant.
**Read by `matchup_rows`** (and through it, the whole Matchups feature) to attach a
role to each scoreboard hero. **A new hero MUST be added here**, or Matchups treats it
as having an unknown role. → New Season Runbook, hero step.

### ⭐ `hero_stats_normalised` — HARDCODED stat-name folding (125 rules)
Reads raw `hero_stats` and, via a big `CASE`, folds each stat's singular/plural OCR
variants to one canonical name (e.g. `'FINAL BLOW'`/`'FINAL BLOWS'` → `FINAL BLOWS`).
**A brand-new stat name MUST be added here too**, or its value won't normalise on the DB
side. Read by `hero_match_facts`, `hero_stat_facts`, `hero_breakdown_stats` (+ alpha twin).
→ New Season Runbook, stat step.

**Output columns** (previously undocumented — assuming `stat_name` here costs a failed
query): `id`, `hero_performance_id`, **`stat_canonical`** (the folded name — this is what
every downstream view and page reads), **`stat_name_raw`** (the untouched OCR text),
`stat_value`, `avg_per_10_min`, `stat_num`.

**Clause shape** — a new fold is one `WHEN` inside the `CASE`, listing every spelling:
```sql
when upper(trim(both from stat_name)) = any (array['LIMIT BREAK KILL','LIMIT BREAK KILLS'])
     then 'LIMIT BREAK KILLS'
```

⚠️ **This does NOT mirror `STAT_NORMALISE` in `src/data/stat-meta.ts` — it is AHEAD of it.**
The code file's comment says to keep them in sync, and until v1.1.1 they were not: the view
folded `FINAL BLOW(S)`, `SOLO KILL(S)` and `PLAYER(S) SAVED` correctly the whole time while
the code map had no rule for any of them. **The database was right and the code was the side
that had drifted**, so analytics were never wrong — the only live consumer of the code map is
`new-content-readiness.ts` (raw OCR, not view output), which false-flagged them on `/testing`.
Those three were exactly the foldable ROLE tiles, which are excluded from the code map's
generation source by design. **When adding a role tile, add the fold in BOTH places.**

**(v1.1.1)** +4 rules: `FUSION REPEATER KILL(S)`, `LIMIT BREAK KILL(S)`,
`PLAYER(S) PROTECTED`, and `PLAYER(S) SAVED` on the code side. Percentages need no rule —
they have no plural, so they pass through the `ELSE` unchanged.

## Foundation views (read by many others)

- **`match_team_damage`** — per match: `ally_total_damage`, `enemy_total_damage`,
  `ally_total_deaths` (sums over `scoreboard_players` by team). ⚠️ Has a **deep
  dependent tree** — to add a column use `CREATE OR REPLACE` and append last; you
  cannot `DROP` it without cascading.
- **`user_scoreboard_row`** — the user's own scoreboard row per match (damage/healing/
  mitigation), filtered `is_user = true`.
- **`hero_match_games`** / **`…_with_alpha`** — one row per hero per match with
  `eff_play_time_seconds` (uses `play_time_seconds`, or derives from
  `percent_played` × game length). The plain one excludes alpha.
- **`match_overview`** — per-match summary + `heroes_played` array; excludes alpha.
  Powers the matches list / recent form.
  > **✅ (v1.1.0 Phase 4) EXTENDED — 4 columns APPENDED, none moved.** Now also carries
  > `question_scale_version` (from the `seasons` join it already had), `matchup_feel`,
  > `performance_rating`, `fun_rating_6`. 19 columns total. `CREATE OR REPLACE` can only
  > APPEND — never reorder, rename or remove — so the original 15 are reproduced verbatim in
  > their original order. `s.question_scale_version` also had to join the `GROUP BY`.
  > **The point is self-description:** a consumer can tell which question set a row belongs
  > to without joining anything, which is what the never-pool rule needs.
  > ⚠️ **The documented "this will go blank on new matches" warning was WRONG.** Nothing
  > read the v1 feel columns: `/matches` selects `id, heroes_played`, Home selects
  > `id, result, map, played_at`. Verified by grep. The real version-2 blank was on
  > `matches/[id]` (the match DETAIL page), which reads `matches` directly and rendered only
  > `fun_rating` as five stars.
  > ⚠️ **KNOWN, UNFIXED: `heroes_played` is `{NULL}` — a one-element array containing null —
  > for a match with no `hero_performances` rows** (the 9 above), because `array_agg` over a
  > LEFT JOIN emits one null row rather than an empty array. `/matches` does
  > `heroes_played || []`, which passes it through, so those rows render a null hero entry.
  > Deliberately left out of the Phase 4 change so it stayed a pure append. Fix is
  > `array_remove(array_agg(hp.hero_name ORDER BY hp.display_order), NULL)`.

## Hero analytics views (all dynamic — new heroes flow through automatically)

- **`hero_analytics`** — per hero × role: games, W/L/D, win rate, avg % played.
  Groups straight from `hero_performances` + `matches`; **not** hardcoded.
- **`hero_winloss`** / **`…_with_alpha`** — per hero W/L/D + win rate.
- **`hero_ead_stats`** / **`…_with_alpha`** — per-hero E/A/D from scoreboard.
- **`hero_pct_stats`** / **`…_with_alpha`** — per-hero damage/healing/mitigation share %.
- **`hero_card_stats`** / **`…_with_alpha`** — combines winloss + ead + pct into the
  hero "card" summary (the pre-aggregated headline numbers; the #9 "Phase B" surfaces).
- **`hero_breakdown_stats`** / **`…_with_alpha`** — per-hero, per-stat averages
  (`avg_per_game`, `avg_per_10_min`), reading the normalised stat names.
- **`hero_match_facts`** — the wide per-hero-per-match fact row (joins many sources
  incl. `hero_stats_normalised`, `match_team_damage`, `user_scoreboard_row`).
- **`hero_stat_facts`** — per-hero-per-match stat rows (canonical names + numeric value).
- **`combat_facts`** — the big Combat-page view: `FROM hero_match_facts JOIN matches`,
  carrying role, is_alpha, leaver flags, damage/death totals and shares. Carries
  `is_alpha` so the page can filter both ways.
  **(v1.1.0)** Rebuilt to add `team_leaver_type`, `enemy_leaver_type`,
  `team_thrower`, `enemy_thrower`, appended at the END so existing ordinal
  positions are untouched. All four come from `matches`, which was already
  joined, so no join was added and the row count is unchanged.
  **This is the ONLY view exposing leaver data** — verified against
  `information_schema`, not assumed. Every other performance surface reads
  `matches` directly via `matchQuery`, so it can select the new columns with no
  view change. Rebuilt from `pg_get_viewdef`, never hand-written from the column
  list a page selects.
  *Invariant:* `count(*) from combat_facts` must equal `count(*) from
  hero_match_facts` (inner join on a guaranteed parent). Verified 372 = 372
  after the v1.1.0 rebuild.

## Map / role / season views (all dynamic)

- **`map_analytics`** — per map × mode × role: games, W/L, win rate. **Groups
  dynamically from `matches`** — a new map needs no change here. Excludes alpha.
- **`role_season_analytics`** — per season × role: games, wins, win rate, avg fun.
- *(season/role come straight from match columns — never hardcoded.)*

## Matchup views (dynamic, but depend on the hardcoded `hero_role_ref`)

> **⚠️ (v1.1.0, 8 Aug 2026) TWO OF THESE VIEWS WERE REWRITTEN AND ARE LIVE.**
> `matchup_rows` and `matchup_user` were changed via `CREATE OR REPLACE` (column lists
> byte-identical, so all dependents survived untouched). Rollback SQL exists in
> `matchup-views-fix.sql`. Read the two entries below before touching anything in this chain.

- **`matchup_rows`** — the base matchup fact: each scoreboard hero vs the user's
  anchor hero, **joined to `hero_role_ref`** for roles. (This is the chain that makes
  a new hero need the `hero_role_ref` update.)
  > **⚠️ CHANGED v1.1.0 — `is_alpha` now reads the real column.** It previously computed
  > `m.season_id IS NULL AS is_alpha`, which is *not* what alpha means. That gave the right
  > answer only by coincidence (all 192 real matches have a season; all 96 alpha matches, written
  > 19 May – 1 Jun outside any season, do not). It would have broken the first time a localhost
  > test match was written **during a live season** — such rows auto-assign a `season_id` from
  > `played_at` and would then read as REAL, leaking alpha data into Matchups while `matchQuery()`
  > correctly excluded it everywhere else. Now reads `m.is_alpha`.

- **`matchup_user`** — **one row per HERO PLAYED per match** (≥30s floor).
  > **⚠️ CHANGED v1.1.0 — this was the single biggest data defect found in the app.**
  > It previously used `SELECT DISTINCT ON (hp.match_id) … ORDER BY play_time_seconds DESC`,
  > i.e. ONE anchor hero per match — the one played longest. Every hero-swap game was therefore
  > **invisible to the hero played second**. Measured: 327 hero-appearances collapsed to 179
  > anchor slots, a **45% loss**; pair-level suppression ran 40–50% (Cassidy 21 games played → 7
  > anchored; `Zarya vs Zarya` showed 0 of 5 real games).
  >
  > The decisive argument was **internal consistency**, not sample size: Hero Analytics reported
  > 21 games of Cassidy while Matchups reported 7 — two incompatible definitions of "a game with
  > this hero" in one app. Per-hero-per-match is the grain every other surface already uses.
  >
  > **Result after the fix: 148 lost hero-appearances → 17, an 89% recovery.** The remaining 17
  > are **leaver games** and are correct — no `scoreboard_players` rows means no `matchup_rows`
  > row, so no hero in that match can reach Matchups.
  >
  > **`anchor_role` is now derived from `hero_role_ref` per anchor hero** (was `mr.role`, the
  > user's scoreboard row — correct for only one anchor once a match has several).
  >
  > **The `COALESCE(ph.anchor_hero, mr.hero_name)` fallback is PRESERVED and load-bearing.**
  > When no `hero_performances` row clears 30s, the anchor falls back to the user's scoreboard
  > hero. This currently rescues **9 matches** (was documented as 8 — see the correction) that
  > would otherwise contribute nothing (see the
  > `hero_performances` warning in Part A). Those rows carry NULL `anchor_pct` / `anchor_seconds`,
  > so `anchor_is_mixed` evaluates to NULL rather than false. Accepted and deliberate.

- **`matchup_pairs`** — anchor-vs-other pairings (carries is_alpha).
  > **⚠️ GRAIN CHANGED v1.1.0.** Now carries roughly **1.8× the rows**, because a match appears
  > once per hero played rather than once. **Per-hero match counts no longer sum to the total
  > match count** — one match legitimately appears under two heroes. This is correct and matches
  > Hero Analytics; say so in any sparsity note rather than "fixing" it.
  > **⚠️ `season_id` IS NOW READ (v1.1.0 Phase 2) — do not drop it.** It was carried by
  > `matchup_pairs` and `matchup_team_sets` but consumed by nothing until the Matchups page
  > gained its season filter. **No view change was needed precisely because the column was
  > already there.** A future rewrite of this chain must keep it: it is no longer a spare
  > column, and removing it would break the filter with no SQL error to point at it.

- **`matchup_single_agg`** / **`matchup_team_sets`** — aggregated matchup outputs.
  > **⚠️ ANALYST TRAP.** `matchup_single_agg` groups by `anchor_hero, relation, other_hero,
  > other_role, match_format`. Any comparison query that joins to it **without `match_format`**
  > gets one row per format, each holding only its share of the games, and will badly overstate
  > differences. Count `distinct match_id` from `matchup_pairs` instead.

**Read-side note (`matchups-lib.ts`).** All five aggregation paths were audited against the new
grain and are games-weighted by distinct `match_id`. One regression was found and fixed:
`conformance222` added the user back into the 6v6 team shape using `anchor_role`, which is now
per-hero and non-deterministic across rows; it uses `user_role_played` (from `matches.role_played`)
instead.

---

# PART C — HOW TABLES CONNECT (foreign keys)

```
seasons.id            ◀── matches.season_id
matches.id            ◀── hero_performances.match_id
matches.id            ◀── scoreboard_players.match_id
matches.id            ◀── match_images.match_id
hero_performances.id  ◀── hero_stats.hero_performance_id
builder_saved_charts.config_key   ◀── builder_chart_views.config_key
builder2_saved_charts.config_key  ◀── builder2_chart_views.config_key
```

Everything hangs off `matches`. Delete a match and its hero_performances /
scoreboard_players / hero_stats go with it (via the FK chain).

---

# PART D — RULES OF THUMB FOR THIS DATABASE

1. **Pages read views, not raw tables, for analytics.** When a number looks wrong,
   check the view definition (`pg_get_viewdef`) before the table.
2. **Adding a column to a view:** use `CREATE OR REPLACE VIEW` and append the new
   column **last** (it can append but not reorder/rename/remove). To change shape,
   you must `DROP` then `CREATE` — but you **cannot** drop a view others depend on
   without cascading (notably `match_team_damage`, which has 6 dependents).
3. **`_with_alpha` twins exist so localhost can see test data; live uses the plain
   view.** Keep the pair in sync if you edit one.
4. **`avg_per_10_min` (in `hero_stats` and the breakdown views) is not trusted** —
   it's raw OCR, ~60% reliable. The primary stat value is the reliable one.
5. **Only `hero_role_ref` and `hero_stats_normalised` are hardcoded.** Every other
   view is dynamic. That's the whole hero/map maintenance surface in the DB.

---

# APPENDIX — quick inventory

**Tables (13):** matches, hero_performances, hero_stats, scoreboard_players, seasons,
user_settings, match_images, beta_issue_log, **match_standouts (v1.1.0)**,
builder_saved_charts, builder_chart_views, builder2_saved_charts, builder2_chart_views.

**Enums:** `leaver_type` (`none`/`left`/`returned`) — v1.1.0.

**Views (28):** combat_facts, hero_analytics, hero_breakdown_stats(+_with_alpha),
hero_card_stats(+_with_alpha), hero_ead_stats(+_with_alpha), hero_match_facts,
hero_match_games(+_with_alpha), hero_pct_stats(+_with_alpha), **hero_role_ref ⭐**,
hero_stat_facts, **hero_stats_normalised ⭐**, hero_winloss(+_with_alpha), map_analytics,
match_overview, match_team_damage, matchup_pairs, matchup_rows, matchup_single_agg,
matchup_team_sets, matchup_user, role_season_analytics, user_scoreboard_row.

**CHECK constraints worth knowing:** matches.match_format (5v5/6v6), matches.fun_rating
(1–5), **matches.matchup_feel (1–5), matches.performance_rating (1–5),
matches.fun_rating_6 (1–6), match_standouts.slot (1–12) (v1.1.0)**,
scoreboard_players role/team/slot/method, user_settings.theme_mode, seasons date
order, beta_issue_log.event (the 6 event types). **None hardcode hero/map/stat values**
(the role check is only tank/dps/support, which won't change).

---

# PART F — v1.1.0 MIGRATION SQL (verbatim)

> **Why this is embedded here.** The handover is four documents only. This is the exact SQL
> that creates the Phase 1 schema — reproduced in full so no separate file is needed.
> Run each STEP as a SEPARATE EXECUTION: the Supabase SQL editor returns only the LAST
> statement's result, so batching hides errors.
>
> **Status: STEPS 1–4 HAVE BEEN RUN.** Verification 2 confirmed the leaver seeding
> (179 none/none, 8 enemy-left, 4 team-left, 1 both = 192, every boolean matching its type).
> Reproduced for reference and rollback, not as an outstanding action.

```sql
-- ============================================================
-- PHASE 1 SCHEMA MIGRATION — v1.1.0
-- Overwatch Ranked Tracker
--
-- RUN IN THE SUPABASE SQL EDITOR. Not stored in the repo.
-- Run each STEP as a SEPARATE EXECUTION, in order.
-- (The SQL editor only returns the LAST statement's result, so batching
--  hides errors and verification output.)
--
-- ⚠️ TIMING: run this only when you are ready to BUILD against it.
-- New columns sitting unused are harmless, but feel-lib.ts and the Feel
-- page need their compatibility layer in the SAME patch. Do not let the
-- schema drift far ahead of the code.
--
-- ⚠️ NOTHING HERE IS DESTRUCTIVE. No column is dropped, no type altered,
-- no existing value rewritten. Every old field is FROZEN in place and keeps
-- its Season 3 data. Rollback is at the bottom.
--
-- GOVERNING DECISION (see PATCH-SPEC §3.1):
-- Old and new answers are NEVER compared or pooled. Therefore we add NEW
-- COLUMNS rather than altering enum types. Season 3 reads the old set;
-- Season 4 onward reads the new. The scale version on `seasons` decides which.
-- ============================================================


-- ============================================================
-- STEP 1 — seasons: question-scale version
-- ============================================================
-- The rule: a feel/question scale holds for an ENTIRE SEASON and changes
-- only at a boundary. Charts ask the season what scale it used instead of
-- hardcoding "season 3 onwards", which breaks silently the next time the
-- questions change -- and they are expected to keep changing.
--
-- A per-match stamp was considered and rejected as redundant given the
-- season-locked working practice.

alter table seasons
  add column if not exists question_scale_version smallint not null default 1;

comment on column seasons.question_scale_version is
  'Which feel/question scale this season was played under. 1 = original '
  '(match_feel, performance_feel, fun_rating 1-5, tilt_mood, tempo, coordination). '
  '2 = v1.1.0 (matchup_feel, performance_rating, fun_rating_6; tilt/tempo/coordination retired). '
  'Set when the season is created in Settings. Never pool data across versions.';

-- Season 3 and everything before it stays on version 1 via the default.
-- Season 4 must be created with version 2. Set it explicitly when you add it:
--   update seasons set question_scale_version = 2 where name = '<Season 4 name>';


-- ============================================================
-- STEP 2 — matches: the new feel columns
-- ============================================================
-- Q1 MATCH-UP (5 points) — "How did you feel your team matched up against the enemy?"
--   1 Outclassed  (never had a chance)
--   2 Behind      (they had the edge throughout)
--   3 Even        (genuinely contested)
--   4 Ahead       (we had the edge throughout)
--   5 Dominant    (never in doubt)
-- Keeps its midpoint deliberately: "evenly matched" is the exact state the
-- founding hypothesis (a tight loss is still fun) is about. Measures TEAM
-- STRENGTH, not result -- Behind + victory is legitimate and interesting.
-- Replaces the 3-value match_feel enum. NO mapping from old data.
--
-- Q2 PERFORMANCE (5 points) — "How did you play?"
--   1 Off my game  (I was part of the problem)
--   2 Below par    (not my usual standard)
--   3 Did my job   (normal game for me)
--   4 Played well  (better than usual)
--   5 Carried      (I was the reason we were in it)
-- ⚠️ WATCH: if "Did my job" exceeds 40% of answers it is behaving like the
-- old fun 3/4 pair and should be cut to four points at the next boundary.
--
-- Q3 FUN (6 points) — deliberately NO midpoint, so every answer must lean.
--   1 Miserable  (I wanted to stop playing)
--   2 Bad        (actively unpleasant, but I saw it out)
--   3 Poor       (no, I didn't enjoy that)
--   4 Good       (yes, I enjoyed that)
--   5 Great      (I'd happily play that again)
--   6 Brilliant  (memorable -- the reason I play)
-- The scale is one binary question -- did I enjoy this? -- with two intensity
-- steps either side. The 3/4 boundary is the whole decision.
--
-- WHY fun_rating_6 AND NOT AN ALTERED CHECK ON fun_rating:
-- fun_rating carries CHECK (1-5). Widening it to 6 would let 5-point and
-- 6-point answers share one column, breaking the never-pool rule at the
-- STORAGE level -- a 5 would be ambiguous forever. A separate column makes
-- the two scales physically unmixable.
--
-- NAMING: no _v2 suffixes. Version suffixes rot; these are named for what
-- they measure. The old columns stay frozen alongside them.

alter table matches
  add column if not exists matchup_feel       smallint,
  add column if not exists performance_rating smallint,
  add column if not exists fun_rating_6       smallint;

alter table matches
  add constraint matches_matchup_feel_range
    check (matchup_feel is null or matchup_feel between 1 and 5) not valid;
alter table matches
  add constraint matches_performance_rating_range
    check (performance_rating is null or performance_rating between 1 and 5) not valid;
alter table matches
  add constraint matches_fun_rating_6_range
    check (fun_rating_6 is null or fun_rating_6 between 1 and 6) not valid;

-- NOT VALID skips the scan of existing rows (all NULL, so they pass anyway)
-- but the constraint is enforced on every future insert and update.

comment on column matches.matchup_feel is
  '1-5. How the teams matched up: 1 Outclassed, 2 Behind, 3 Even, 4 Ahead, 5 Dominant. '
  'Team strength, NOT result. Scale version 2 only; version 1 seasons use match_feel.';
comment on column matches.performance_rating is
  '1-5. How I played: 1 Off my game, 2 Below par, 3 Did my job, 4 Played well, 5 Carried. '
  'Scale version 2 only; version 1 seasons use performance_feel.';
comment on column matches.fun_rating_6 is
  '1-6, NO midpoint: 1 Miserable, 2 Bad, 3 Poor, 4 Good, 5 Great, 6 Brilliant. '
  'Scale version 2 only; version 1 seasons use fun_rating (1-5). NEVER pool the two.';


-- ============================================================
-- STEP 3 — matches: three-state leaver type
-- ============================================================
-- WHY THIS MATTERS STRUCTURALLY:
-- Today a "leaver game" means ZERO scoreboard_players rows -- /process does
-- `scoreboard: isLeaverGame ? null : rawResult.scoreboard`. That is CORRECT
-- for a permanent leaver and must not change: detectScoreboard derives its
-- grid from the VS-gap to decide 5 or 6 rows per side, calibrated to
-- 3840x2160. A missing row makes the board ASYMMETRIC, so slot N may not be
-- the player the extractor believes it is. That is structural misalignment,
-- not merely distorted stats.
--
-- A RETURNED leaver is different: at screenshot time the board has its full
-- complement of rows, so the geometry is intact and only the NUMBERS are
-- skewed. Store it, tag it, exclude it from scoreboard-derived surfaces.
--
--   none     -> scoreboard written, counts everywhere
--   returned -> scoreboard WRITTEN, excluded from scoreboard-derived surfaces
--               (combat shares, matchups, pairings, match_team_damage)
--   left     -> no scoreboard at all (unchanged behaviour)
--
-- THE BOOLEANS ARE KEPT AND KEPT IN SYNC. team_leaver/enemy_leaver are read
-- in many places (builder-lib variable registry, combat_facts, the Home
-- leaver displays). Nothing breaks on day one; pages migrate at their own pace.
-- Do NOT drop them in this patch.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'leaver_type') then
    create type leaver_type as enum ('none', 'left', 'returned');
  end if;
end $$;

alter table matches
  add column if not exists team_leaver_type  leaver_type not null default 'none',
  add column if not exists enemy_leaver_type leaver_type not null default 'none';

-- Seed from the existing booleans. Historical data cannot distinguish
-- left-forever from left-and-returned, so every existing leaver becomes
-- 'left' -- the conservative reading, and the one consistent with those
-- matches having no scoreboard rows.
update matches set team_leaver_type  = 'left' where team_leaver  is true;
update matches set enemy_leaver_type = 'left' where enemy_leaver is true;

comment on column matches.team_leaver_type is
  'none/left/returned. ''left'' = never came back (NO scoreboard rows exist -- the board '
  'is geometrically asymmetric and cannot be trusted). ''returned'' = came back, scoreboard '
  'IS written but must be excluded from scoreboard-derived surfaces. Keep team_leaver in sync.';


-- ============================================================
-- STEP 4 — match_standouts (impressed ally / struggled enemy)
-- ============================================================
-- Captured ON THE PHONE, immediately after the match, because the player
-- remembers this straight away -- /process can run three days later, by which
-- point the answer is invented rather than recalled.
--
-- STORED AS SLOT, RESOLVED TO HERO AT SAVE TIME, AFTER THE HERO AUDIT.
-- The hero behind a slot is not trustworthy until HeroAuditPanel has been
-- through it, so a corrected misidentification must carry through to the pick.
-- hero_name is therefore NULLABLE until resolution.
--
-- SLOT CONVENTION (mirrors scoreboard_players):
--   5v5 -> ally 1-5,  enemy 6-10
--   6v6 -> ally 1-6,  enemy 7-12
-- `team` is deliberately NOT stored: slot is unique within a match, so the
-- join back is match_id + slot alone and team comes free from
-- scoreboard_players. A team column would be a third copy of the same fact.
-- A CHECK cannot enforce slot-vs-kind consistency because the valid ranges
-- depend on matches.match_format, which is not visible to a row constraint.
-- Enforce that in the app.
--
-- A SEPARATE TABLE, NOT COLUMNS ON `matches` — deliberately. The owner may
-- retire this feature in a few patches; a standalone child table is one
-- DROP TABLE away from gone, leaving no orphaned columns and nothing to
-- unpick from a view chain.
--
-- NO ROWS FOR PERMANENT-LEAVER GAMES: there is no scoreboard, so the step
-- is skipped entirely.

create table if not exists match_standouts (
  id         bigint generated always as identity primary key,
  match_id   bigint   not null references matches(id) on delete cascade,
  kind       text     not null check (kind in ('impressed_ally', 'struggled_enemy')),
  slot       smallint not null check (slot between 1 and 12),
  hero_name  text,
  created_at timestamptz not null default now(),
  unique (match_id, kind, slot)
);

create index if not exists match_standouts_match_id_idx  on match_standouts (match_id);
create index if not exists match_standouts_hero_name_idx on match_standouts (hero_name);

-- ⚠️ RLS IS MANDATORY. All 12 base tables have RLS ON with a permissive
-- "authenticated full access" policy. A new table WITHOUT a policy is
-- silently unreadable from the app -- queries return zero rows with no error,
-- which is a miserable thing to debug.
alter table match_standouts enable row level security;

drop policy if exists "authenticated full access" on match_standouts;
create policy "authenticated full access" on match_standouts
  for all to authenticated using (true) with check (true);

comment on table match_standouts is
  'Post-match subjective picks: which ally impressed, which enemy gave trouble. '
  'Captured by SLOT on the phone; hero_name resolved at save time AFTER the hero audit. '
  'Multiple picks allowed per kind; an explicit "none" answer writes NO rows. '
  'Never written for permanent-leaver games (no scoreboard exists). '
  'Surfaced on the Matchups page, which already computes the denominator '
  '(games where that hero appeared, by relation).';


-- ============================================================
-- VERIFICATION — run after all four steps
-- ============================================================

-- 1. New columns present and empty; old columns untouched.
select
  count(*)                                          as total_matches,
  count(matchup_feel)                               as new_matchup_feel,
  count(performance_rating)                         as new_performance,
  count(fun_rating_6)                               as new_fun6,
  count(match_feel)                                 as old_match_feel,
  count(fun_rating)                                 as old_fun5
from matches where not is_alpha;
-- EXPECT: total 192, all three new_* = 0, old_match_feel and old_fun5 = 192.

-- 2. Leaver types seeded consistently with the booleans.
select team_leaver, team_leaver_type, enemy_leaver, enemy_leaver_type, count(*)
from matches where not is_alpha
group by 1,2,3,4 order by 1,2,3,4;
-- EXPECT: every true boolean pairs with 'left'; every false with 'none'.
-- NO row should show a true boolean against 'none'.

-- 3. Season versions.
select id, name, question_scale_version from seasons order by id;
-- EXPECT: all existing seasons = 1. Season 4 must be created as 2.

-- 4. match_standouts exists, is empty, and RLS is on with a policy.
select (select count(*) from match_standouts)                              as rows_now,
       (select relrowsecurity from pg_class where relname='match_standouts') as rls_enabled,
       (select count(*) from pg_policies where tablename='match_standouts') as policy_count;
-- EXPECT: 0, true, 1.


-- ============================================================
-- ROLLBACK
-- ============================================================
/*
drop table if exists match_standouts;

alter table matches
  drop column if exists matchup_feel,
  drop column if exists performance_rating,
  drop column if exists fun_rating_6,
  drop column if exists team_leaver_type,
  drop column if exists enemy_leaver_type;

drop type if exists leaver_type;

alter table seasons drop column if exists question_scale_version;
*/

```

---

# PART G — MATCHUP VIEW REWRITE (verbatim, ALREADY APPLIED)

> **Status: LIVE.** Applied and verified — 148 lost hero-appearances fell to 17, and the
> residual 17 are leaver games (no scoreboard, so no matchup row) which is correct.
> Reproduced here so the definitions and the ROLLBACK are available without a separate file.

```sql
-- ============================================================
-- Matchup views — Phase 0a / Phase 3 fix
-- Overwatch Ranked Tracker
--
-- RUN IN THE SUPABASE SQL EDITOR. Not stored in the repo.
-- Run STEP 1 and STEP 2 in order, as separate executions.
--
-- Both use CREATE OR REPLACE and keep the column list byte-identical
-- (same names, same order, same types), so dependent views survive.
-- Dependents: matchup_rows -> matchup_user -> matchup_pairs ->
--             matchup_single_agg + matchup_team_sets.
--
-- Rollback for both is at the bottom of this file.
-- ============================================================


-- ============================================================
-- STEP 1 — matchup_rows: use the REAL alpha column
-- ============================================================
-- WAS:  m.season_id IS NULL AS is_alpha
-- This is not what alpha means. It happens to give the right answer TODAY
-- (all 192 real matches have a season; all 96 alpha matches, written
-- 19 May - 1 Jun outside any season, do not) -- but it breaks the moment a
-- localhost test match is written DURING a live season, which Phase 3
-- requires for hero 54. Those rows auto-assign a season_id from played_at
-- and would then read as REAL, leaking alpha data into Matchups while
-- matchQuery() correctly excludes it everywhere else in the app.

create or replace view matchup_rows as
 select sp.match_id,
    sp.slot,
    sp.team,
    sp.is_user,
    sp.hero_name,
    coalesce(hr.role, sp.role) as role,
    hr.role is null as hero_role_unknown,
    hr.role is not null and hr.role <> sp.role as role_icon_disagrees,
    m.season_id,
    m.is_alpha,
    m.map,
    m.game_mode,
    m.match_format,
    m.role_played as user_role_played,
    m.result,
    m.played_at
   from scoreboard_players sp
     join matches m on m.id = sp.match_id
     left join hero_role_ref hr on hr.hero_name = sp.hero_name;


-- ============================================================
-- STEP 2 — matchup_user: one row per HERO PLAYED, not one per match
-- ============================================================
-- WAS:  SELECT DISTINCT ON (hp.match_id) ... ORDER BY play_time_seconds DESC
--       i.e. a single anchor hero per match, the one played longest.
--
-- Every hero-swap game was invisible to the hero played second. Measured:
-- 327 hero-appearances (>=30s, non-alpha) collapsed to 179 anchor slots -- a
-- 45% loss. Pair-level suppression ran 40-50% (Mizuki vs Soldier: 76 showed 5
-- of 10 real games; Zarya vs Zarya showed 0 of 5).
--
-- The decisive argument is INTERNAL CONSISTENCY, not sample size: Hero
-- Analytics reports 21 games of Cassidy, Matchups reported 7. Same data, two
-- incompatible definitions of "a game with this hero". Per-hero-per-match is
-- the grain every other surface already uses.
--
-- The >=30s floor matches hero_match_facts (lowered 60 -> 30 in v38).
--
-- anchor_role NOW COMES FROM hero_role_ref, not mr.role. mr.role is the user's
-- SCOREBOARD row -- correct for one anchor, wrong for the others once a match
-- has several. Falls back to mr.role when the hero is not in hero_role_ref.
--
-- The COALESCE(ph.anchor_hero, mr.hero_name) fallback is PRESERVED: a match
-- with no qualifying hero_performances row still yields its scoreboard hero,
-- exactly as before.
--
-- EXPECTED: matchup_pairs row count rises roughly 1.8x. Match counts per hero
-- will no longer sum to total matches, because one match legitimately appears
-- under two heroes. That is correct and matches Hero Analytics -- say so in the
-- sparsity note so it is not later read as a bug.

create or replace view matchup_user as
 with played_heroes as (
         select hp.match_id,
            hp.hero_name as anchor_hero,
            hp.percent_played as anchor_pct,
            hp.play_time_seconds as anchor_seconds
           from hero_performances hp
          where coalesce(hp.play_time_seconds, 0) >= 30
        )
 select mr.match_id,
    coalesce(ph.anchor_hero, mr.hero_name) as anchor_hero,
    ph.anchor_pct,
    ph.anchor_seconds,
    ph.anchor_pct is not null and ph.anchor_pct < 95::numeric as anchor_is_mixed,
    coalesce(hr.role, mr.role) as anchor_role,
    mr.season_id,
    mr.is_alpha,
    mr.map,
    mr.game_mode,
    mr.match_format,
    mr.user_role_played,
    mr.result,
    mr.played_at
   from matchup_rows mr
     left join played_heroes ph on ph.match_id = mr.match_id
     left join hero_role_ref hr
            on hr.hero_name = coalesce(ph.anchor_hero, mr.hero_name)
  where mr.is_user = true;


-- ============================================================
-- VERIFICATION — run after both steps
-- ============================================================

-- 1. Anchor coverage should now track hero_performances, not sit ~45% below it.
--    games_as_anchor should equal games_played for every hero.
with played as (
  select hp.hero_name, count(distinct hp.match_id) as games_played
  from hero_performances hp join matches m on m.id = hp.match_id
  where not m.is_alpha and coalesce(hp.play_time_seconds,0) >= 30
  group by 1
),
anchored as (
  select anchor_hero as hero_name, count(distinct match_id) as games_as_anchor
  from matchup_pairs where not is_alpha group by 1
)
select p.hero_name, p.games_played, coalesce(a.games_as_anchor,0) as games_as_anchor,
       p.games_played - coalesce(a.games_as_anchor,0) as still_lost
from played p left join anchored a using (hero_name)
order by still_lost desc, p.games_played desc;

-- 2. Alpha must not leak. Expect 96 alpha / 192 real, matching the matches table.
select is_alpha, count(distinct match_id) as matches
from matchup_rows group by 1 order by 1;

-- 3. anchor_role must never be null for a hero present in hero_role_ref.
select count(*) filter (where anchor_role is null) as null_roles
from matchup_user;


-- ============================================================
-- ROLLBACK — restores both views to their pre-patch definitions
-- ============================================================
/*
create or replace view matchup_rows as
 select sp.match_id, sp.slot, sp.team, sp.is_user, sp.hero_name,
    coalesce(hr.role, sp.role) as role,
    hr.role is null as hero_role_unknown,
    hr.role is not null and hr.role <> sp.role as role_icon_disagrees,
    m.season_id,
    m.season_id is null as is_alpha,
    m.map, m.game_mode, m.match_format,
    m.role_played as user_role_played, m.result, m.played_at
   from scoreboard_players sp
     join matches m on m.id = sp.match_id
     left join hero_role_ref hr on hr.hero_name = sp.hero_name;

create or replace view matchup_user as
 with primary_hero as (
         select distinct on (hp.match_id) hp.match_id,
            hp.hero_name as anchor_hero,
            hp.percent_played as anchor_pct,
            hp.play_time_seconds as anchor_seconds
           from hero_performances hp
          order by hp.match_id, hp.play_time_seconds desc nulls last
        )
 select mr.match_id,
    coalesce(ph.anchor_hero, mr.hero_name) as anchor_hero,
    ph.anchor_pct, ph.anchor_seconds,
    ph.anchor_pct is not null and ph.anchor_pct < 95::numeric as anchor_is_mixed,
    mr.role as anchor_role,
    mr.season_id, mr.is_alpha, mr.map, mr.game_mode, mr.match_format,
    mr.user_role_played, mr.result, mr.played_at
   from matchup_rows mr
     left join primary_hero ph on ph.match_id = mr.match_id
  where mr.is_user = true;
*/

```


---

# PART G — v1.1.0 EXCLUDED-GAMES MIGRATIONS (verbatim, both applied 9 Aug 2026)

Both returned "Success. No rows returned", which is correct for DDL.

```sql
-- ---- G1. user_settings: three visibility switches ----
begin;

alter table user_settings
  add column if not exists show_permanent_leavers boolean not null default false,
  add column if not exists show_returned_leavers  boolean not null default false,
  add column if not exists show_throwers          boolean not null default false;

-- show_leaver_games meant "show ANY leaver game", so it seeds BOTH leaver switches.
update user_settings
   set show_permanent_leavers = coalesce(show_leaver_games, false),
       show_returned_leavers  = coalesce(show_leaver_games, false)
 where show_leaver_games is not null;

-- LEFT IN PLACE deliberately: dropping a column in the same release as the code
-- that stops using it has no rollback.
comment on column user_settings.show_leaver_games is
  'DEPRECATED (v1.1.0). Superseded by show_permanent_leavers + show_returned_leavers. Retained for rollback safety; drop once no code references it.';

commit;

-- ---- G2. combat_facts: expose leaver types + throwers ----
-- Rebuilt from pg_get_viewdef with four columns APPENDED (ordinals preserved).
-- The full statement is in migration-combat-facts.sql; the addition is:
--     m.team_leaver_type, m.enemy_leaver_type, m.team_thrower, m.enemy_thrower
-- appended after hmf.ally_total_deaths. No new join; row count unchanged.
```

## Verification queries worth keeping

```sql
-- Which views expose leaver data, and which column sets they carry.
-- Answer on 9 Aug 2026: combat_facts ONLY, and now all three sets.
select table_name,
       count(*) filter (where column_name = 'team_leaver')      as has_leaver_bool,
       count(*) filter (where column_name = 'team_leaver_type') as has_leaver_type,
       count(*) filter (where column_name = 'team_thrower')     as has_thrower
  from information_schema.columns
 where table_schema = 'public'
   and table_name in (select table_name from information_schema.views
                       where table_schema = 'public')
   and column_name in ('team_leaver','team_leaver_type','team_thrower')
 group by table_name
having count(*) filter (where column_name = 'team_leaver') > 0;

-- Expected game counts per switch combination (live, non-alpha).
-- All off = 176 · +throwers = 179 · +permanent leavers = 192 · returned changes nothing.
select
  count(*) filter (where team_thrower or enemy_thrower)              as thrower_matches,
  count(*) filter (where (team_thrower or enemy_thrower)
                     and team_leaver_type = 'none'
                     and enemy_leaver_type = 'none')                 as thrower_only,
  count(*) filter (where team_leaver_type = 'left'
                      or enemy_leaver_type = 'left')                 as permanent_leaver,
  count(*)                                                           as total
  from matches
 where not is_alpha;
```

⚠️ **The thrower count differs with and without the alpha filter** — 5 rows total,
4 non-alpha. Any count intended to match what the app displays must exclude alpha.

---

# PART H — v1.1.0 PHASE 4 MIGRATION (written 9 Aug 2026, **applied 10 Aug 2026**)

⚠️ **THIS WAS NOT LIVE WHEN THIS SECTION WAS FIRST WRITTEN.** The heading previously read
"verbatim, applied 9 Aug 2026". `pg_get_viewdef` on 10 Aug returned the PRE-Phase-4
definition, so the statement below was written but never executed — or was executed and
later overwritten by a `create or replace` built from an older copy. Which of the two is
undetermined and is deliberately recorded as undetermined.

**It is live now.** The Phase 5 migration in Part I supersedes this statement: it contains
the same four appended columns PLUS the `heroes_played` fix, and applying it applied both.
**Run Part I, not this.** This section is kept as the record of what Phase 4 intended.

The only database change in Phase 4. One view, no dependents, nothing destructive.

⚠️ **`CREATE OR REPLACE VIEW` can only APPEND columns** — it cannot reorder, rename or
remove them. The first 15 columns below are therefore reproduced byte-for-byte from the
previous definition, in their original order, and the 4 new ones follow. Adding
`s.question_scale_version` also required adding it to the `GROUP BY`, because `seasons` was
grouped by `s.name` alone.

```sql
-- match_overview — expose the version-2 feel columns + the question scale version.
create or replace view match_overview as
 SELECT m.id,
    m.played_at,
    s.name AS season_name,
    m.map,
    m.game_mode,
    m.result,
    m.score,
    m.role_played,
    m.game_length_seconds,
    m.total_eliminations,
    m.total_assists,
    m.total_deaths,
    m.fun_rating,
    m.match_feel,
    array_agg(hp.hero_name ORDER BY hp.display_order) AS heroes_played,
    -- appended v1.1.0 Phase 4 --
    s.question_scale_version,
    m.matchup_feel,
    m.performance_rating,
    m.fun_rating_6
   FROM matches m
     LEFT JOIN seasons s ON m.season_id = s.id
     LEFT JOIN hero_performances hp ON hp.match_id = m.id
  WHERE m.is_alpha = false
  GROUP BY m.id, s.name, s.question_scale_version;
```

**Verification — expect 19 rows, with the original 15 unmoved:**

```sql
select column_name, ordinal_position
from information_schema.columns
where table_name = 'match_overview'
order by ordinal_position;
```

## Diagnostic queries from the Phase 4 investigation (worth keeping)

**Every match with no hero breakdown, all time.** This is the query that corrected the
count from 8 to 9 — the earlier figure came from a hand-listed set of ids rather than a
query, and one match was missed.

```sql
select m.id, m.played_at, m.map, m.match_format, m.season_id
from matches m
left join (select match_id, count(*) n from hero_performances group by 1) hp
       on hp.match_id = m.id
where not m.is_alpha and coalesce(hp.n, 0) = 0
order by m.played_at;
```

**Breakdown-loss rate by format, over a window.** This is what turned "some matches are
missing hero rows" into "6v6 loses them 8× more often".

```sql
select m.match_format,
       count(*) as matches,
       count(*) filter (where coalesce(hp.n, 0) > 0) as with_hero_rows,
       count(*) filter (where coalesce(hp.n, 0) = 0) as without_hero_rows
from matches m
left join (select match_id, count(*) n from hero_performances group by 1) hp
       on hp.match_id = m.id
where not m.is_alpha
  and m.played_at >= '2026-07-20' and m.played_at < '2026-08-05'
group by 1;
```

⚠️ **Do NOT try to join `beta_issue_log` to `matches`.** Its `match_id` is `text` holding
13-digit epoch batch ids — a plain comparison errors with *"operator does not exist: text >=
integer"*, and casting errors with *"value ... is out of range for type integer"* once it
reaches a 13-digit value. Both were hit during this investigation before the column was
understood. See the `beta_issue_log` entry.

---

# PART I — v1.1.0 PHASE 5 MIGRATION (verbatim, applied 10 Aug 2026)

**Closes open item #19.** One view, no dependents, nothing destructive. This statement is
what is actually live; **Part H is superseded by it** and kept only as a record of intent.

## What it changed

Two things in one `create or replace`, because the live view turned out to be missing both:

1. **The four Phase 4 columns** (`question_scale_version`, `matchup_feel`,
   `performance_rating`, `fun_rating_6`), appended at positions 16–19, with
   `s.question_scale_version` added to the `GROUP BY` as Phase 4 required.
2. **The `heroes_played` `{NULL}` fix** — the Phase 5 change proper.

## The `{NULL}` bug, and why it is not an empty array

`array_agg` over a LEFT JOIN does **not** return an empty array when the joined side has no
rows. It returns a **one-element array containing NULL**: `{NULL}`. Nine matches have no
`hero_performances` rows, so `heroes_played` read `{NULL}` for them. `/matches` does
`heroes_played || []`, and because `{NULL}` is a non-empty array that guard passed it
straight through, rendering one blank hero entry per affected match.

`array_remove(..., NULL)` collapses `{NULL}` to `{}`, and the existing read-side guard then
behaves as it was always meant to. **No read-side change was needed** — which is why the
`/matches` edit listed as pending in earlier revisions of this file was dropped rather than
done.

⚠️ **`array_remove` strips EVERY null, not only the all-null case.** A populated
`heroes_played` containing a stray null alongside real heroes would lose that null and come
back one element shorter. Desirable, but it is a silent change to a match outside the nine —
hence the cardinality spot-check below.

## ⚠️ Before editing this view again — dump it first

```sql
select pg_get_viewdef('match_overview'::regclass, true);
```

Phase 4's statement was documented here as applied and was not. **A documented migration is
not an applied one.** Rebuild any new statement from THIS output, not from this file.

## The migration

```sql
create or replace view match_overview as
 SELECT m.id,
    m.played_at,
    s.name AS season_name,
    m.map,
    m.game_mode,
    m.result,
    m.score,
    m.role_played,
    m.game_length_seconds,
    m.total_eliminations,
    m.total_assists,
    m.total_deaths,
    m.fun_rating,
    m.match_feel,
    -- v1.1.0 Phase 5: array_remove collapses the LEFT JOIN's {NULL} to {}.
    array_remove(array_agg(hp.hero_name ORDER BY hp.display_order), NULL) AS heroes_played,
    -- appended v1.1.0 Phase 4 --
    s.question_scale_version,
    m.matchup_feel,
    m.performance_rating,
    m.fun_rating_6
   FROM matches m
     LEFT JOIN seasons s ON m.season_id = s.id
     LEFT JOIN hero_performances hp ON hp.match_id = m.id
  WHERE m.is_alpha = false
  GROUP BY m.id, s.name, s.question_scale_version;
```

⚠️ **Why `create or replace` accepts this.** It can only APPEND columns — never reorder,
rename, remove or retype them. Changing column 15's EXPRESSION is permitted because its
name (`heroes_played`), type (`text[]`) and ordinal position are all unchanged.

## Verification (run after) — ✅ ALL THREE PASSED, 11 Aug 2026

> **⚠️ THE PHASE 5 MIGRATION IS CONFIRMED LIVE.** All three queries below were run against
> the live database on 11 Aug 2026 and returned their expected results:
> `null_array_matches = 0`, `empty_array_matches = 9`, `total_rows = 192`, column list 19
> rows, cardinality check zero rows. This view is verified APPLIED, not merely documented —
> which is the exact distinction the correction at the top of this file exists to enforce.
>
> **⚠️ THE THREE QUERIES ARE NOT INTERCHANGEABLE. Run all of them.** The cardinality check
> (third) INNER JOINs against a `hero_performances` grouping, so the nine breakdown-less
> matches have no group, never enter the join, and are **invisible to it by construction**.
> It proves only that no match WITH a breakdown lost a hero. The `{NULL}` count (first) is
> the only query that sees the nine at all. A clean third query with the first unrun says
> nothing about whether `{NULL}` became `{}` — during Phase 6 exactly that inference was
> nearly drawn, and the first query had to be run separately to close it.

```sql
-- Expect null_array_matches = 0, empty_array_matches = 9, total_rows unchanged.
-- The nine MOVED from {NULL} to {} — they did not disappear.
-- ✅ CONFIRMED live 11 Aug 2026: 0 / 9 / 192.
select
  count(*) filter (where heroes_played = array[null]::text[])  as null_array_matches,
  count(*) filter (where cardinality(heroes_played) = 0)       as empty_array_matches,
  count(*)                                                     as total_rows
from match_overview;

-- Column list — expect 19 rows, original 15 in their original order. ✅ CONFIRMED live.
select column_name, ordinal_position
from information_schema.columns
where table_name = 'match_overview'
order by ordinal_position;

-- No match that HAS heroes lost any. Expect ZERO rows returned. ✅ CONFIRMED live 11 Aug 2026.
-- ⚠️ CANNOT see the nine breakdown-less matches — the inner join excludes them. Not a
-- substitute for the {NULL} count above.
select mo.id, cardinality(mo.heroes_played) as in_view, hp.n as in_table
from match_overview mo
join (select match_id, count(*) as n from hero_performances group by match_id) hp
  on hp.match_id = mo.id
where cardinality(mo.heroes_played) <> hp.n;
```

## Rollback

```sql
-- Restores the Phase 4 expression (keeps the four appended columns).
-- Reintroduces the {NULL} behaviour on the nine breakdown-less matches.
create or replace view match_overview as
 SELECT m.id, m.played_at, s.name AS season_name, m.map, m.game_mode, m.result, m.score,
    m.role_played, m.game_length_seconds, m.total_eliminations, m.total_assists,
    m.total_deaths, m.fun_rating, m.match_feel,
    array_agg(hp.hero_name ORDER BY hp.display_order) AS heroes_played,
    s.question_scale_version, m.matchup_feel, m.performance_rating, m.fun_rating_6
   FROM matches m
     LEFT JOIN seasons s ON m.season_id = s.id
     LEFT JOIN hero_performances hp ON hp.match_id = m.id
  WHERE m.is_alpha = false
  GROUP BY m.id, s.name, s.question_scale_version;
```
