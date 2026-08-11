'use client'

import {
  MAPS,
  HEROES,
  getMapsByMode,
  type GameMode,
} from '@/data/reference'
import { isExcludedGame } from '@/lib/leaver'
import Select from '@/components/Select'
import MultiSelect from '@/components/MultiSelect'

// ============================================================
// ANALYTICS FILTERS — shared across every analytics page
// ------------------------------------------------------------
// SCOPE filters (left group): Queue, Mode, Map, Hero, Season.
// THRESHOLD filters (right group): Min games, Playtime %.
//
//   • Queue carries the 5v5/6v6 split and is SINGLE-SELECT. Tank/DPS/Support
//     are 5v5 roles; 6v6 is its own queue. 5v5 and 6v6 NEVER mix (hard product
//     rule) — which is also why the control can't become multi-select: ticking
//     Tank and 6v6 together would ask for exactly the mix the rule forbids.
//   • Mode, Map, Hero and Season are MULTI-SELECT (v1.1.0 Phase 2).
//   • Mode → Map are linked: picking modes narrows the map list to those modes'
//     maps, and any selected map that falls outside is dropped automatically.
//   • Hero is the full reference roster, SCOPED BY THE QUEUE ROLE ONLY:
//       Queue = Tank/DPS/Support → only that role's heroes are offered.
//       Queue = All or 6v6       → all heroes are offered.
//     (No extra "hero role" sub-step — that's a Match-History-only pattern.)
//
// ⚠️ EMPTY ARRAY = NO FILTER, for all four multi-selects. `maps: []` means
// every map, not "no maps". This replaced a sentinel mess where mode used the
// string 'all' while map and hero used '' — the mismatch that caused the v1.0.1
// empty-page bug, when `'' ?? 'all'` stayed '' across the Matchups bridge and
// rejected every row. There is now one rule and no sentinel to translate.
//
// MULTI-SELECT SEMANTICS (settled, PATCH-SPEC §6.2):
//   • WITHIN one filter: OR.  Three maps ticked = matches on any of them.
//   • ACROSS filters: AND.    "these maps AND these heroes."
//   • Hero on aggregate pages: POOLED across the selected heroes — see
//     heroMatches() at the bottom.
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
// HERO-GATING: the threshold group is HERO-FOCUSED, so it renders ONLY when at
// least one specific hero is selected. Under "All Heroes" it stays hidden. A
// page declares which thresholds it SUPPORTS via `show`; the hero gate decides
// WHEN the supported ones are visible.
//
// Controlled component: the parent owns the state and passes it in, so every
// page shares one filter shape. Built standalone for reuse.
//
// ⚠️ ONE APPLICATION PATH (v1.1.0 Phase 2). Filtering happens in JS, on rows
// already fetched, via matchesFilters(). The SQL-side twin — applyMatchQueryFilters()
// — was DELETED, along with the applyFilters() array wrapper. Both were written,
// both were correct, and grep confirmed neither had ever been called by anything.
// Keeping them meant the excluded-games rule existed in two implementations that
// could drift, in a copy that never ran and so could never reveal it had. If a
// database-side path is ever needed (it isn't at this data volume), rebuild it
// then against whatever the state shape is by that point.
// ============================================================

export type QueueFilter = 'all' | 'tank' | 'dps' | 'support' | '6v6'

// Threshold options. Kept as explicit small sets (not free numbers) because the
// user asked for tap-to-pick dropdowns with specific allowed values, not a slider.
export const MIN_GAMES_OPTIONS = [5, 10] as const
export const PLAYTIME_PCT_OPTIONS = [95, 90] as const
export const DEFAULT_MIN_GAMES = 5
export const DEFAULT_PLAYTIME_PCT = 95

export interface AnalyticsFilterState {
  /** Single-select. 6v6 is a format; a 5v5 role pins format AND role_played. */
  queue: QueueFilter
  /** [] = all modes. */
  modes: GameMode[]
  /** [] = all maps. */
  maps: string[]
  /** [] = all heroes. Pooled when several are selected. */
  heroes: string[]
  /** [] = All Time (no season filter); else exactly these season ids. */
  seasons: number[]
  // Threshold knobs (step 9). Reactive + per-visit; NOT persisted. Each page that
  // opts into them reads these instead of a local constant. A page that doesn't
  // show them just keeps the defaults, so its behaviour is unchanged.
  minGames: number // confidence floor: buckets under this many games are dimmed
  playtimePct: number // % of a match on a hero to count it as a "single-hero" game
}

/** A season the filter can offer. Subset of the `seasons` table. */
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
  modes: [],
  maps: [],
  heroes: [],
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

const MODE_OPTIONS: { value: GameMode; label: string }[] = [
  { value: 'escort', label: 'Escort' },
  { value: 'control', label: 'Control' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'push', label: 'Push' },
  { value: 'flashpoint', label: 'Flashpoint' },
]

// Heroes offered for a given queue. A specific 5v5 role narrows to that role;
// All/6v6 offers the whole roster. Sorted by name; full static reference roster.
//
// (v1.1.0 Phase 5) EXPORTED. Hero Pairings restricts its whole hero universe to
// the selected queue's roster, and that is the same question this function
// already answers for the Hero dropdown. Exported rather than copied so there is
// exactly one definition of "which heroes are possible in this queue" — two would
// drift the first time a hero changed role.
export function heroOptionsForQueue(queue: QueueFilter): string[] {
  const all = [...HEROES].sort((a, b) => a.name.localeCompare(b.name))
  if (queue === 'tank' || queue === 'dps' || queue === 'support') {
    return all.filter(h => h.role === queue).map(h => h.name)
  }
  return all.map(h => h.name)
}

// Maps offered for a set of modes. No modes selected = every map. Several modes
// = the UNION of their maps, deduped by name (the same map can serve more than
// one mode in reference data, and a duplicated row would tick twice).
function mapNamesForModes(modes: GameMode[]): string[] {
  const src = modes.length === 0 ? [...MAPS] : modes.flatMap(m => getMapsByMode(m))
  return Array.from(new Set(src.map(m => m.name))).sort((a, b) => a.localeCompare(b))
}

export default function AnalyticsFilters({
  value,
  onChange,
  show = { queue: true, mode: true, map: true, hero: true, season: true },
  seasonOptions = [],
}: {
  value: AnalyticsFilterState
  onChange: (next: AnalyticsFilterState) => void
  show?: FilterVisibility
  seasonOptions?: SeasonOption[]
}) {
  const mapOptions = mapNamesForModes(value.modes)
  const heroOptions = heroOptionsForQueue(value.queue)

  // When the queue role changes, previously-chosen heroes may no longer be in
  // the offered set — drop those so the visible selection can't contradict Queue.
  // Survivors are kept: switching Tank → All should not throw away your picks.
  function changeQueue(queue: QueueFilter) {
    const offered = new Set(heroOptionsForQueue(queue))
    onChange({ ...value, queue, heroes: value.heroes.filter(h => offered.has(h)) })
  }

  // When the modes change, drop any selected map that no longer belongs to one
  // of them. Clearing to "All Modes" widens the offer, so nothing is dropped.
  function changeModes(modes: GameMode[]) {
    const offered = new Set(mapNamesForModes(modes))
    onChange({ ...value, modes, maps: value.maps.filter(m => offered.has(m)) })
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
            <MultiSelect<GameMode>
              className={selectCls}
              value={value.modes}
              onChange={changeModes}
              options={MODE_OPTIONS}
              allLabel="All Modes"
              noun="modes"
              aria-label="Mode"
            />
          </label>
        )}

        {show.map && (
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Map</span>
            <MultiSelect<string>
              className={selectCls}
              value={value.maps}
              onChange={maps => onChange({ ...value, maps })}
              options={mapOptions.map(m => ({ value: m, label: m }))}
              allLabel="All Maps"
              noun="maps"
              searchable
              searchPlaceholder="Search maps…"
              aria-label="Map"
            />
          </label>
        )}

        {show.hero && (
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Hero</span>
            <MultiSelect<string>
              className={selectCls}
              value={value.heroes}
              onChange={heroes => onChange({ ...value, heroes })}
              options={heroOptions.map(h => ({ value: h, label: h }))}
              allLabel="All Heroes"
              noun="heroes"
              searchable
              searchPlaceholder="Search heroes…"
              aria-label="Hero"
            />
          </label>
        )}

        {/* Season stays hidden until seasons exist — that's why the control is
            invisible before the first season is created, not a bug. */}
        {show.season && seasonOptions.length > 0 && (
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Season</span>
            <MultiSelect<number>
              className={selectCls}
              value={value.seasons}
              onChange={seasons => onChange({ ...value, seasons })}
              options={seasonOptions.map(s => ({ value: s.id, label: s.name }))}
              allLabel="All Time"
              noun="seasons"
              aria-label="Season"
            />
          </label>
        )}
      </div>

      {/* THRESHOLD filters (right group) — confidence/inclusion knobs, not row
          filters. These are HERO-FOCUSED tools, so they appear ONLY when at
          least one specific hero is selected. With "All Heroes" they stay
          hidden, because the aggregate view across every hero isn't what
          they're for. A page still declares which thresholds it SUPPORTS via
          `show`; the hero gate decides WHEN they're visible. */}
      {value.heroes.length > 0 && (show.minGames || show.playtimePct) && (
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
// ONE path: a JS predicate over rows the page has already fetched. Hero is
// applied separately (see heroMatches) because the hero field's name and shape
// differ between a flat `matches` read and the hero-grain views.
// ============================================================

export interface FilterableMatch {
  match_format: '5v5' | '6v6'
  role_played: 'tank' | 'dps' | 'support'
  game_mode: string | null
  map: string | null
  // Optional: present on rows read from `matches` (and any view that SELECTs
  // them). Used only when matchesFilters is called with { applyExclusions: true }.
  //
  // (v1.1.0) The leaver BOOLEANS alone are not enough: they are true for both a
  // permanent and a returned leaver, and those now have separate switches. A
  // filtering surface should select EXCLUSION_COLS so the type and thrower
  // columns come through too — with booleans only, isExcludedGame() falls back
  // to treating every leaver as permanent.
  team_leaver?: boolean | null
  enemy_leaver?: boolean | null
  team_leaver_type?: string | null
  enemy_leaver_type?: string | null
  team_thrower?: boolean | null
  enemy_thrower?: boolean | null
  // Optional: present on rows carrying season_id. Used for the season filter;
  // a row without it is treated as season_id = null (only matched by All Time).
  season_id?: number | null
}

export function matchesFilters<T extends FilterableMatch>(
  row: T,
  f: AnalyticsFilterState,
  opts?: { applyExclusions?: boolean }
): boolean {
  // Queue — single-select, unchanged. 6v6 pins the format; a 5v5 role pins both
  // the format and the role queued.
  if (f.queue === '6v6') {
    if (row.match_format !== '6v6') return false
  } else if (f.queue !== 'all') {
    if (row.match_format !== '5v5' || row.role_played !== f.queue) return false
  }
  // Mode / Map — OR within each filter, AND between them. [] = no filter.
  // A row with a null value is only ever matched by the empty (all) selection:
  // it belongs to none of the ticked options, so ticking any of them excludes it.
  if (f.modes.length > 0 && !(row.game_mode != null && (f.modes as string[]).includes(row.game_mode))) {
    return false
  }
  if (f.maps.length > 0 && !(row.map != null && f.maps.includes(row.map))) {
    return false
  }
  // Season — same rule. [] = All Time; a row with null/absent season_id belongs
  // to no specific season and so only shows under All Time.
  if (f.seasons.length > 0 && !(row.season_id != null && f.seasons.includes(row.season_id))) {
    return false
  }
  // Excluded-games policy (opt-in). Delegates to @/lib/leaver, which owns all
  // three switches — permanent leavers, returned leavers, throwers.
  //
  // ⚠️ (v1.1.0) THE CALLER NO LONGER DECIDES. This used to take a boolean the
  // page computed from showLeaverGames(), which meant every page held a copy of
  // the rule and a page could disagree with the others. It now takes a plain
  // opt-in: pass applyExclusions and the user's current policy is applied.
  //
  // Surfaces that must see every game (Feel, Builder) stay exempt by NOT
  // passing it — exemption by omission, so a new page is exempt only if it
  // deliberately says nothing rather than by remembering to opt out.
  //
  // The row must carry the columns in EXCLUSION_COLS for this to distinguish
  // permanent from returned leavers; see isExcludedGame() for what happens when
  // it doesn't.
  if (opts?.applyExclusions && isExcludedGame(row)) {
    return false
  }
  return true
}

/**
 * Hero predicate, applied per-page once the row's hero(es) are known.
 * `heroesInRow` is whatever heroes that row represents (one, or a list).
 * Returns true when no hero filter is active or the row includes ANY selected hero.
 *
 * POOLED, per PATCH-SPEC §6.2. Ana + Kiriko ticked means a row counts if it
 * involves either of them — their games pool into one set. It does NOT mean
 * "every match where either appeared, including my other heroes' rows from
 * those matches"; that would drag unselected heroes' data in through the back
 * door. Rows are matched on the heroes they actually represent.
 */
export function heroMatches(
  heroesInRow: string | string[] | null | undefined,
  f: AnalyticsFilterState
): boolean {
  if (f.heroes.length === 0) return true
  if (heroesInRow == null) return false
  return Array.isArray(heroesInRow)
    ? heroesInRow.some(h => f.heroes.includes(h))
    : f.heroes.includes(heroesInRow)
}
