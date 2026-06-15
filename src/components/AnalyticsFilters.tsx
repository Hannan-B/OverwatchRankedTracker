'use client'

import {
  MAPS,
  HEROES,
  getMapsByMode,
  type GameMode,
} from '@/data/reference'
import { matchQuery } from '@/lib/alpha'
import Select from '@/components/Select'

// ============================================================
// ANALYTICS FILTERS — shared across every analytics page
// ------------------------------------------------------------
// SCOPE filters (left group): Queue, Mode, Map, Hero, Season.
// THRESHOLD filters (right group): Min games, Playtime %.
//
//   • Queue carries the 5v5/6v6 split. Tank/DPS/Support are 5v5 roles; 6v6 is
//     its own queue. 5v5 and 6v6 NEVER mix (hard product rule).
//   • Mode → Map are linked: picking a mode narrows the map list to that mode,
//     and an out-of-mode map selection is cleared automatically.
//   • Hero is the full reference roster, SCOPED BY THE QUEUE ROLE ONLY:
//       Queue = Tank/DPS/Support → only that role's heroes are offered.
//       Queue = All or 6v6       → all heroes are offered.
//     (No extra "hero role" sub-step — that's a Match-History-only pattern.)
//
// THRESHOLDS (step 9) — confidence/inclusion knobs, NOT row filters. They live
// in the same shared state so any page can read them, but each page applies them
// itself (a threshold means different things on different pages):
//   • minGames: how many games a bucket needs before it stops being dimmed as
//     "low confidence". Default 5; the only other offered value is 10. This is
//     reactive + per-visit (no DB persistence) — resets to default each visit.
//   • playtimePct: how much of a match you must have played a hero on for it to
//     count as a "single-hero" game on the surfaces that read it. Default 95;
//     the only other offered value is 90. Reactive + per-visit, same as above.
//     ⚠️ Only the pages where this lives in page/lib code honour it; surfaces
//     whose single-hero flag is computed in a SQL view are NOT reached by it.
//   • TIME-FLOOR (the "counts as a game" ≥60s rule) — Phase A lowered the SQL
//     views' hard floor to 30s so the read side can filter live; the website
//     re-applies 60s by default. Wired per page where it's reachable.
//
// HERO-GATING: the threshold group is HERO-FOCUSED, so it renders ONLY when a
// specific hero is selected (value.hero !== ''). Under "All heroes" it stays
// hidden. A page declares which thresholds it SUPPORTS via `show`; the hero gate
// decides WHEN the supported ones are visible.
//
// Controlled component: the parent owns the state and passes it in, so every
// page shares one filter shape. Built standalone for reuse.
//
// Applying the filters (two paths, pick per page — see §3 of the handover):
//   1. Reading the `matches` table directly → use applyMatchQueryFilters(),
//      which pushes .eq() into a matchQuery() builder (alpha rule included).
//   2. Reading SQL views (or already-fetched rows) → use matchesFilters() as a
//      JS predicate after fetching.
// ============================================================

export type QueueFilter = 'all' | 'tank' | 'dps' | 'support' | '6v6'
export type ModeFilter = 'all' | GameMode

// Threshold options. Kept as explicit small sets (not free numbers) because the
// user asked for tap-to-pick dropdowns with specific allowed values, not a slider.
export const MIN_GAMES_OPTIONS = [5, 10] as const
export const PLAYTIME_PCT_OPTIONS = [95, 90] as const
export const DEFAULT_MIN_GAMES = 5
export const DEFAULT_PLAYTIME_PCT = 95

export interface AnalyticsFilterState {
  queue: QueueFilter
  mode: ModeFilter
  map: string // '' = all maps
  hero: string // '' = all heroes
  seasons: number[] // [] = All Time (no season filter); else exactly these season ids
  // Threshold knobs (step 9). Reactive + per-visit; NOT persisted. Each page that
  // opts into them reads these instead of a local constant. A page that doesn't
  // show them just keeps the defaults, so its behaviour is unchanged.
  minGames: number // confidence floor: buckets under this many games are dimmed
  playtimePct: number // % of a match on a hero to count it as a "single-hero" game
}

/** A season the filter can offer as a checkbox (subset of the `seasons` table). */
export interface SeasonOption {
  id: number
  name: string
}

/** Which filters a page wants rendered. Omitted keys are hidden (kept at default). */
export interface FilterVisibility {
  queue?: boolean
  mode?: boolean
  map?: boolean
  hero?: boolean
  season?: boolean
  minGames?: boolean
  playtimePct?: boolean
}

export const DEFAULT_FILTERS: AnalyticsFilterState = {
  queue: 'all',
  mode: 'all',
  map: '',
  hero: '',
  seasons: [],
  minGames: DEFAULT_MIN_GAMES,
  playtimePct: DEFAULT_PLAYTIME_PCT,
}

// Shared control styling. Centralised so the (deferred) app-wide restyle is a
// one-place change rather than a per-page sweep.
const selectCls =
  'bg-ow-dark border border-ow-line rounded-lg px-3 py-2 text-sm text-ow-fg ' +
  'font-display tracking-wider focus:border-ow-orange focus:outline-none transition-colors ' +
  '[color-scheme:dark]'

const labelCls = 'text-[11px] text-ow-muted font-display tracking-wider uppercase'

// Heroes offered for a given queue. A specific 5v5 role narrows to that role;
// All/6v6 offers the whole roster. Sorted by name; full static reference roster.
function heroOptionsForQueue(queue: QueueFilter): string[] {
  const all = [...HEROES].sort((a, b) => a.name.localeCompare(b.name))
  if (queue === 'tank' || queue === 'dps' || queue === 'support') {
    return all.filter(h => h.role === queue).map(h => h.name)
  }
  return all.map(h => h.name)
}

export default function AnalyticsFilters({
  value,
  onChange,
  show = { queue: true, mode: true, map: true, hero: true, season: true },  seasonOptions = [],
}: {
  value: AnalyticsFilterState
  onChange: (next: AnalyticsFilterState) => void
  show?: FilterVisibility
  seasonOptions?: SeasonOption[]
}) {
  // Maps shown depend on the chosen mode (Mode→Map linkage).
  const mapOptions =
    value.mode === 'all'
      ? [...MAPS].sort((a, b) => a.name.localeCompare(b.name))
      : getMapsByMode(value.mode)

  const heroOptions = heroOptionsForQueue(value.queue)

  // When the queue role changes, a previously-chosen hero may no longer be in
  // the offered set — clear it so the visible selection can't contradict Queue.
  function changeQueue(queue: QueueFilter) {
    const heroStillValid =
      value.hero === '' || heroOptionsForQueue(queue).includes(value.hero)
    onChange({ ...value, queue, hero: heroStillValid ? value.hero : '' })
  }

  // When the mode changes, clear a map that doesn't belong to the new mode.
  function changeMode(mode: ModeFilter) {
    const mapStillValid =
      value.map === '' ||
      mode === 'all' ||
      getMapsByMode(mode).some(m => m.name === value.map)
    onChange({ ...value, mode, map: mapStillValid ? value.map : '' })
  }

  // Season multi-select. [] = All Time (no filtering). Checking "All Time" clears
  // the set; toggling a season adds/removes its id. If unchecking the last season
  // leaves the set empty, that's All Time again (no dead "nothing" state).
  const allTime = value.seasons.length === 0
  function setAllTime() {
    onChange({ ...value, seasons: [] })
  }
  function toggleSeason(id: number) {
    const has = value.seasons.includes(id)
    const next = has ? value.seasons.filter(s => s !== id) : [...value.seasons, id]
    onChange({ ...value, seasons: next })
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      {/* SCOPE filters — narrow which games are in view. */}
      <div className="flex flex-wrap gap-4">
      {show.queue && (
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Queue</span>
          <Select<QueueFilter>
            className={selectCls}
            value={value.queue}
            onChange={changeQueue}
            options={[
              { value: 'all', label: 'All Queues' },
              { value: 'tank', label: 'Tank' },
              { value: 'dps', label: 'DPS' },
              { value: 'support', label: 'Support' },
              { value: '6v6', label: '6v6' },
            ]}
          />
        </label>
      )}

      {show.mode && (
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Mode</span>
          <Select<ModeFilter>
            className={selectCls}
            value={value.mode}
            onChange={changeMode}
            options={[
              { value: 'all', label: 'All Modes' },
              { value: 'escort', label: 'Escort' },
              { value: 'control', label: 'Control' },
              { value: 'hybrid', label: 'Hybrid' },
              { value: 'push', label: 'Push' },
              { value: 'flashpoint', label: 'Flashpoint' },
            ]}
          />
        </label>
      )}

      {show.map && (
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Map</span>
          <Select<string>
            className={selectCls}
            value={value.map}
            onChange={map => onChange({ ...value, map })}
            options={[
              { value: '', label: 'All Maps' },
              ...mapOptions.map(m => ({ value: m.name, label: m.name })),
            ]}
          />
        </label>
      )}

      {show.hero && (
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Hero</span>
          <Select<string>
            className={selectCls}
            value={value.hero}
            onChange={hero => onChange({ ...value, hero })}
            options={[
              { value: '', label: 'All Heroes' },
              ...heroOptions.map(h => ({ value: h, label: h })),
            ]}
          />
        </label>
      )}

      {show.season && seasonOptions.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={labelCls}>Season</span>
          <div className="flex flex-wrap items-center gap-2 bg-ow-dark border border-ow-line rounded-lg px-3 py-2">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allTime}
                onChange={setAllTime}
                className="accent-ow-orange w-3.5 h-3.5"
              />
              <span className={`text-sm font-display tracking-wider ${allTime ? 'text-ow-orange' : 'text-ow-muted'}`}>
                All Time
              </span>
            </label>
            {seasonOptions.map(s => {
              const checked = value.seasons.includes(s.id)
              return (
                <label key={s.id} className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSeason(s.id)}
                    className="accent-ow-orange w-3.5 h-3.5"
                  />
                  <span className={`text-sm font-display tracking-wider ${checked ? 'text-ow-fg' : 'text-ow-muted'}`}>
                    {s.name}
                  </span>
                </label>
              )
            })}
          </div>
        </div>
      )}
      </div>

      {/* THRESHOLD filters (right group) — confidence/inclusion knobs, not row
          filters. These are HERO-FOCUSED tools, so they appear ONLY when a
          specific hero is selected (value.hero !== ''). With "All heroes" they
          stay hidden, because the aggregate view across every hero isn't what
          they're for. A page still declares which thresholds it SUPPORTS via
          `show`; the hero gate decides WHEN they're visible. */}
      {value.hero !== '' && (show.minGames || show.playtimePct) && (
        <div className="flex flex-wrap gap-4">
          {show.minGames && (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>Min games</span>
              <Select<number>
                className={selectCls}
                value={value.minGames}
                onChange={minGames => onChange({ ...value, minGames })}
                options={MIN_GAMES_OPTIONS.map(n => ({ value: n, label: `${n}+` }))}
              />
            </label>
          )}

          {show.playtimePct && (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>Playtime %</span>
              <Select<number>
                className={selectCls}
                value={value.playtimePct}
                onChange={playtimePct => onChange({ ...value, playtimePct })}
                options={PLAYTIME_PCT_OPTIONS.map(n => ({ value: n, label: `${n}%+` }))}
              />
            </label>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================
// FILTER APPLICATION
// ------------------------------------------------------------
// Two ways to apply the same filter state, so every page filters identically.
// Hero is applied per-page (it depends on the row's hero shape, which differs
// between a flat `matches` read and the hero-grain views) — see notes below.
// ============================================================

/**
 * PATH 1 — reading the `matches` table directly.
 * Returns a matchQuery() builder with the alpha rule + Queue/Mode/Map pushed in
 * as .eq() clauses. Chain .order()/.select-derived calls as usual.
 *
 *   const { data } = await applyMatchQueryFilters(
 *     'id, played_at, map, game_mode, result, role_played, match_format', f
 *   ).order('played_at', { ascending: false })
 *
 * NOTE: Hero is NOT applied here — the `matches` table has no single hero column
 * (heroes live in scoreboard_players / hero_performances / match_overview).
 * Pages that filter by hero join/merge that data and apply Hero in JS.
 */
export function applyMatchQueryFilters(
  columns: string,
  f: AnalyticsFilterState,
  opts?: { excludeLeavers?: boolean },
) {
  let q = matchQuery(columns)
  // Queue: 6v6 is a format; a 5v5 role pins both format and role_played.
  if (f.queue === '6v6') {
    q = q.eq('match_format', '6v6')
  } else if (f.queue !== 'all') {
    q = q.eq('match_format', '5v5').eq('role_played', f.queue)
  }
  if (f.mode !== 'all') q = q.eq('game_mode', f.mode)
  if (f.map !== '') q = q.eq('map', f.map)
  // Season multi-select: [] = All Time (no filter); else restrict to those ids.
  if (f.seasons.length > 0) q = q.in('season_id', f.seasons)
  // Leaver exclusion (opt-in, performance surfaces only). A leaver game has
  // team_leaver or enemy_leaver true; exclude both. Feel/Builder DON'T pass this
  // (they analyse leaver games on purpose). The caller decides whether to exclude
  // by reading showLeaverGames() — see leaver.ts — so the toggle is honoured.
  if (opts?.excludeLeavers) {
    q = q.eq('team_leaver', false).eq('enemy_leaver', false)
  }
  return q
}

/**
 * PATH 2 — JS predicate for already-fetched rows (e.g. SQL-view reads).
 * Applies Queue/Mode/Map. Hero is handled separately (see heroMatches) because
 * the hero field name/shape varies by view.
 */
export interface FilterableMatch {
  match_format: '5v5' | '6v6'
  role_played: 'tank' | 'dps' | 'support'
  game_mode: string | null
  map: string | null
  // Optional: present on rows read from `matches` (and any view that SELECTs
  // them). Used only when matchesFilters is called with { excludeLeavers: true }.
  team_leaver?: boolean | null
  enemy_leaver?: boolean | null
  // Optional: present on rows carrying season_id. Used for the season filter;
  // a row without it is treated as season_id = null (only matched by All Time).
  season_id?: number | null
}

export function matchesFilters<T extends FilterableMatch>(
  row: T,
  f: AnalyticsFilterState,
  opts?: { excludeLeavers?: boolean }
): boolean {
  if (f.queue === '6v6') {
    if (row.match_format !== '6v6') return false
  } else if (f.queue !== 'all') {
    if (row.match_format !== '5v5' || row.role_played !== f.queue) return false
  }
  if (f.mode !== 'all' && row.game_mode !== f.mode) return false
  if (f.map !== '' && row.map !== f.map) return false
  // Season multi-select: [] = All Time (no filter); else the row's season_id must
  // be one of the selected ids. A row with null/absent season_id only shows under
  // All Time (it belongs to no specific season).
  if (f.seasons.length > 0 && !(row.season_id != null && f.seasons.includes(row.season_id))) {
    return false
  }
  // Leaver exclusion (opt-in). Only filters when the row carries the flags; a row
  // without them is treated as non-leaver (kept). The caller gates this on
  // showLeaverGames() so the toggle is honoured.
  if (opts?.excludeLeavers && (row.team_leaver === true || row.enemy_leaver === true)) {
    return false
  }
  return true
}

/** Convenience: filter an array with matchesFilters (Queue/Mode/Map only). */
export function applyFilters<T extends FilterableMatch>(
  rows: T[],
  f: AnalyticsFilterState,
  opts?: { excludeLeavers?: boolean }
): T[] {
  return rows.filter(r => matchesFilters(r, f, opts))
}

/**
 * Hero predicate, applied per-page once the row's hero(es) are known.
 * `heroesInRow` is whatever heroes that row represents (one, or a list).
 * Returns true when no hero filter is active or the row includes the hero.
 */
export function heroMatches(
  heroesInRow: string | string[] | null | undefined,
  f: AnalyticsFilterState
): boolean {
  if (f.hero === '') return true
  if (heroesInRow == null) return false
  return Array.isArray(heroesInRow)
    ? heroesInRow.includes(f.hero)
    : heroesInRow === f.hero
}
