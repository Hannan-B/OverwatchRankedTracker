# Supabase Map — Overwatch Ranked Tracker

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
| **New hero** | ✅ **Yes — one view** | `hero_role_ref` hardcodes the 52 heroes→role list. Add the hero here or Matchups won't know its role. |
| **New STAT name** (a stat no existing hero has) | ✅ **Yes — one view** | `hero_stats_normalised` hardcodes ~121 stat-name fold rules. Add the new stat or its value won't normalise in the DB. |

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

### `matches` — one row per game *(the spine of everything)*
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

### `hero_performances` — per-hero breakdown rows for a match
One row per hero you played in a match. `id`, `match_id` → `matches.id`, `hero_name`,
`percent_played`, `play_time_seconds`, `eliminations`, `assists`, `deaths`,
`display_order` (1–3, CHECK). `hero_name` is free text from extraction — a new hero
just shows up here once played.

### `hero_stats` — per-stat breakdown values
One row per stat tile on a hero's breakdown screen. `id`,
`hero_performance_id` → `hero_performances.id`, `stat_name` (raw OCR text),
`stat_value` (**text**), `avg_per_10_min` (**text**, the ~60%-reliable raw OCR
per-10 — not trusted). The raw `stat_name` here is what `hero_stats_normalised`
folds to canonical form.

### `scoreboard_players` — the 10/12-player scoreboard
One row per player slot in a match (NOT for leaver games — those write zero rows).
`id`, `match_id`, `slot` (1–12, CHECK), `team` (ally/enemy, CHECK), `hero_name`,
`role` (tank/dps/support or null, CHECK), `is_user`, `user_match_method`
(ocr_auto/ocr_confirmed/manual_select/hero_match, CHECK), and stats `eliminations`,
`assists`, `deaths`, `damage`, `healing`, `mitigation`. ⚠️ **Other players' gamertags
are never stored** — players are identified by slot + role only.

### `seasons`
`id`, `name`, `start_date`, `end_date` (CHECK: end > start), `created_at`. Matches
auto-assign by `played_at`. Adding a season is done in Settings, not here.

### `user_settings` — single-user preferences
`id`, `gamertag`, `default_role` (unused), `show_leaver_games` (bool, default false —
v34 leaver toggle), `theme_mode` (`'system'`/`'light'`/`'dark'`, CHECK — v40 theme),
timestamps.

### `match_images`
`id`, `match_id`, `image_type`, `storage_path`, `hero_name` (nullable), `created_at`.
⚠️ **Verified empty in practice** — nothing in the pipeline writes to it; image
retention is a future design decision, not built. Leave alone.

### `beta_issue_log` — append-only diagnostics (6f)
`id`, `created_at`, `match_id`, `event`, `field`, `field_detail`, `signal`,
`read_value`, `corrected_value`, `confidence`, `format`, `questions_asked`,
`auto_pass_fields`. The `event` column has a CHECK allowing
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

### ⭐ `hero_role_ref` — HARDCODED 52-hero → role list
A standalone lookup built from an inlined `VALUES` table:
`('D.Va','tank'), ('Doomfist','tank'), … ('Wuyang','support')` — all 52 heroes.
**Read by `matchup_rows`** (and through it, the whole Matchups feature) to attach a
role to each scoreboard hero. **A new hero MUST be added here**, or Matchups treats it
as having an unknown role. → New Season Runbook, hero step.

### ⭐ `hero_stats_normalised` — HARDCODED stat-name folding (~121 rules)
Reads raw `hero_stats` and, via a big `CASE`, folds each stat's singular/plural OCR
variants to one canonical name (e.g. `'FINAL BLOW'`/`'FINAL BLOWS'` → `FINAL BLOWS`).
This **mirrors `STAT_NORMALISE` in `src/data/stat-meta.ts`** — the code file's comment
says to keep them in sync. **A brand-new stat name MUST be added here too**, or its
value won't normalise on the DB side. Read by `hero_match_facts`, `hero_stat_facts`,
`hero_breakdown_stats` (+ alpha twin). → New Season Runbook, stat step.

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

## Map / role / season views (all dynamic)

- **`map_analytics`** — per map × mode × role: games, W/L, win rate. **Groups
  dynamically from `matches`** — a new map needs no change here. Excludes alpha.
- **`role_season_analytics`** — per season × role: games, wins, win rate, avg fun.
- *(season/role come straight from match columns — never hardcoded.)*

## Matchup views (dynamic, but depend on the hardcoded `hero_role_ref`)

- **`matchup_rows`** — the base matchup fact: each scoreboard hero vs the user's
  anchor hero, **joined to `hero_role_ref`** for roles. (This is the chain that makes
  a new hero need the `hero_role_ref` update.)
- **`matchup_user`** — the user's anchor hero per match.
- **`matchup_pairs`** — anchor-vs-other pairings (carries is_alpha).
- **`matchup_single_agg`** / **`matchup_team_sets`** — aggregated matchup outputs.

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

**Tables (12):** matches, hero_performances, hero_stats, scoreboard_players, seasons,
user_settings, match_images, beta_issue_log, builder_saved_charts, builder_chart_views,
builder2_saved_charts, builder2_chart_views.

**Views (28):** combat_facts, hero_analytics, hero_breakdown_stats(+_with_alpha),
hero_card_stats(+_with_alpha), hero_ead_stats(+_with_alpha), hero_match_facts,
hero_match_games(+_with_alpha), hero_pct_stats(+_with_alpha), **hero_role_ref ⭐**,
hero_stat_facts, **hero_stats_normalised ⭐**, hero_winloss(+_with_alpha), map_analytics,
match_overview, match_team_damage, matchup_pairs, matchup_rows, matchup_single_agg,
matchup_team_sets, matchup_user, role_season_analytics, user_scoreboard_row.

**CHECK constraints worth knowing:** matches.match_format (5v5/6v6), matches.fun_rating
(1–5), scoreboard_players role/team/slot/method, user_settings.theme_mode, seasons date
order, beta_issue_log.event (the 6 event types). **None hardcode hero/map/stat values**
(the role check is only tank/dps/support, which won't change).
