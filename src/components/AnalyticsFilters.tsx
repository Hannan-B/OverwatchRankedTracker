'use client'

import {
  MAPS,
  HEROES,
  getMapsByMode,
  type GameMode,
} from '@/data/reference'
import { matchQuery } from '@/lib/alpha'

// ============================================================
// ANALYTICS FILTERS — shared across every analytics page
// ------------------------------------------------------------
// FOUR configurable filters: Queue, Mode, Map, Hero.
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
// A page declares WHICH of the four filters it wants via `show`; the component
// renders only those. Hidden filters keep their default value so the shared
// state shape never changes.
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

export interface AnalyticsFilterState {
  queue: QueueFilter
  mode: ModeFilter
  map: string // '' = all maps
  hero: string // '' = all heroes
}

/** Which filters a page wants rendered. Omitted keys are hidden (kept at default). */
export interface FilterVisibility {
  queue?: boolean
  mode?: boolean
  map?: boolean
  hero?: boolean
}

export const DEFAULT_FILTERS: AnalyticsFilterState = {
  queue: 'all',
  mode: 'all',
  map: '',
  hero: '',
}

// Shared control styling. Centralised so the (deferred) app-wide restyle is a
// one-place change rather than a per-page sweep.
const selectCls =
  'bg-ow-dark border border-white/20 rounded-lg px-3 py-2 text-sm text-slate-100 ' +
  'font-display tracking-wider focus:border-ow-orange focus:outline-none transition-colors ' +
  '[color-scheme:dark]'

const labelCls = 'text-[11px] text-slate-400 font-display tracking-wider uppercase'

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
  show = { queue: true, mode: true, map: true, hero: true },
}: {
  value: AnalyticsFilterState
  onChange: (next: AnalyticsFilterState) => void
  show?: FilterVisibility
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

  return (
    <div className="flex flex-wrap gap-4">
      {show.queue && (
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Queue</span>
          <select
            className={selectCls}
            value={value.queue}
            onChange={e => changeQueue(e.target.value as QueueFilter)}>
            <option value="all">All Queues</option>
            <option value="tank">Tank</option>
            <option value="dps">DPS</option>
            <option value="support">Support</option>
            <option value="6v6">6v6</option>
          </select>
        </label>
      )}

      {show.mode && (
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Mode</span>
          <select
            className={selectCls}
            value={value.mode}
            onChange={e => changeMode(e.target.value as ModeFilter)}>
            <option value="all">All Modes</option>
            <option value="escort">Escort</option>
            <option value="control">Control</option>
            <option value="hybrid">Hybrid</option>
            <option value="push">Push</option>
            <option value="flashpoint">Flashpoint</option>
          </select>
        </label>
      )}

      {show.map && (
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Map</span>
          <select
            className={selectCls}
            value={value.map}
            onChange={e => onChange({ ...value, map: e.target.value })}>
            <option value="">All Maps</option>
            {mapOptions.map(m => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
          </select>
        </label>
      )}

      {show.hero && (
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Hero</span>
          <select
            className={selectCls}
            value={value.hero}
            onChange={e => onChange({ ...value, hero: e.target.value })}>
            <option value="">All Heroes</option>
            {heroOptions.map(h => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </label>
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
export function applyMatchQueryFilters(columns: string, f: AnalyticsFilterState) {
  let q = matchQuery(columns)
  // Queue: 6v6 is a format; a 5v5 role pins both format and role_played.
  if (f.queue === '6v6') {
    q = q.eq('match_format', '6v6')
  } else if (f.queue !== 'all') {
    q = q.eq('match_format', '5v5').eq('role_played', f.queue)
  }
  if (f.mode !== 'all') q = q.eq('game_mode', f.mode)
  if (f.map !== '') q = q.eq('map', f.map)
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
}

export function matchesFilters<T extends FilterableMatch>(
  row: T,
  f: AnalyticsFilterState
): boolean {
  if (f.queue === '6v6') {
    if (row.match_format !== '6v6') return false
  } else if (f.queue !== 'all') {
    if (row.match_format !== '5v5' || row.role_played !== f.queue) return false
  }
  if (f.mode !== 'all' && row.game_mode !== f.mode) return false
  if (f.map !== '' && row.map !== f.map) return false
  return true
}

/** Convenience: filter an array with matchesFilters (Queue/Mode/Map only). */
export function applyFilters<T extends FilterableMatch>(
  rows: T[],
  f: AnalyticsFilterState
): T[] {
  return rows.filter(r => matchesFilters(r, f))
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
