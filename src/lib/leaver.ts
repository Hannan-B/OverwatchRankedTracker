import { supabase } from '@/lib/supabase'

// ============================================================
// EXCLUDED GAMES — visibility policy, single source of truth
// ============================================================
//
// (v1.1.0) This file used to hold ONE preference: show_leaver_games, meaning
// "show any match with a leaver". It now holds THREE, because that single
// switch was conflating three different kinds of bad game:
//
//   1. PERMANENT leaver  (leaver_type = 'left')
//        Their row VANISHES from the scoreboard, so the board is a row short.
//        No scoreboard_players rows exist for the match at all — /process
//        discards the board rather than store a misaligned one. Hiding these is
//        about the match record; there are no scoreboard stats to hide.
//
//   2. RETURNED leaver   (leaver_type = 'returned')
//        Came back before the end, so at screenshot time the board has its full
//        complement of rows. The geometry is intact and the scoreboard IS
//        stored — only the NUMBERS are skewed by the time they spent away.
//
//   3. THROWER
//        A complete, entirely VALID scoreboard. Nothing is wrong with the data;
//        these are excluded because they are annoying, which makes this a pure
//        preference rather than a data-integrity rule. That distinction is why
//        throwers are NEVER filtered at write time — see PATCH-SPEC §4.3.
//
// Preferences live in user_settings (not localStorage) because they are real
// user preferences that apply on LIVE and should follow you across devices —
// unlike alpha, which is a localhost-only dev control.
//
//   EXEMPT — always see every game regardless of these switches:
//     • Feel     — its leaver/thrower charts exist to analyse these games.
//                  Filtering them there would remove the page's own subject.
//     • Builder  — leaver/thrower are selectable variables.
//     • The Home leaver callout boxes — they count leaver games on purpose.
//   Exemption is expressed by NOT calling into this module, so a surface is
//   exempt by omission rather than by an opt-out flag it could forget to set.
//
// SYNC READ-SIDE: the analytics read-side is synchronous (filters run inline,
// no awaiting). A DB value can't be read synchronously, so the prefs are loaded
// ONCE into a module-level cache and read from the cache thereafter:
//   • loadExclusionPrefs()  — async; call once on page load to fill the cache
//   • exclusionPrefs()      — sync; reads the cache
//   • setExclusionPref()    — async; writes DB + cache (immediate local effect)
//   • isExcludedGame(row)   — sync; the single predicate every surface uses
//   • keepIncluded(rows)    — sync; array form of the above
//
// COLD-LOAD DEFAULT: before loadExclusionPrefs() resolves, everything is
// hidden. A brief flash of "hidden" is better than briefly showing distorted
// data as though it were real.

export interface ExclusionPrefs {
  /** Show matches where someone left and never came back. */
  showPermanentLeavers: boolean
  /** Show matches where someone left and returned. */
  showReturnedLeavers: boolean
  /** Show matches with a thrower (ally or enemy — one switch covers both). */
  showThrowers: boolean
}

export type ExclusionKey = keyof ExclusionPrefs

/** All three default to hidden. Throwers hiding is NEW in v1.1.0 and will move
 *  headline numbers slightly on release; the thrower count is small, and this
 *  switch is the first thing to try if a number looks wrong after upgrading. */
const DEFAULTS: ExclusionPrefs = {
  showPermanentLeavers: false,
  showReturnedLeavers: false,
  showThrowers: false,
}

let cached: ExclusionPrefs = { ...DEFAULTS }
let loaded = false

/**
 * Load all three preferences into the cache. Call once on page load. Safe to
 * call repeatedly. Never throws; on any error the cache stays at its safe
 * (everything hidden) default.
 */
export async function loadExclusionPrefs(): Promise<ExclusionPrefs> {
  try {
    const { data } = await supabase
      .from('user_settings')
      .select('show_permanent_leavers, show_returned_leavers, show_throwers')
      .limit(1)
      .single()
    const row = data as Record<string, boolean | null> | null
    cached = {
      showPermanentLeavers: row?.show_permanent_leavers === true,
      showReturnedLeavers: row?.show_returned_leavers === true,
      showThrowers: row?.show_throwers === true,
    }
  } catch {
    cached = { ...DEFAULTS }
  }
  loaded = true
  return cached
}

/** Back-compat alias. Pages call this in their load effect; keeping the old
 *  name means those call sites don't have to change in the same commit as
 *  everything else. */
export const loadLeaverPref = loadExclusionPrefs

/** Have the prefs been loaded from the DB yet this session? Pages hold this in
 *  a state flag and include it in their filter memo deps, so the filter re-runs
 *  once the real values arrive. */
export function exclusionPrefsLoaded(): boolean {
  return loaded
}

/** Read the current preferences synchronously. */
export function exclusionPrefs(): ExclusionPrefs {
  return cached
}

/**
 * Flip one switch. Writes user_settings (so it syncs across devices) AND
 * updates the cache (so the session reflects it immediately). Upserts the
 * single user_settings row if it doesn't exist yet.
 *
 * The write persists ALL THREE preferences, not just the one flipped — see the
 * comment on the payload below. The stored row therefore always matches the
 * cache rather than being assembled from separate per-column writes.
 */
export async function setExclusionPref(key: ExclusionKey, next: boolean): Promise<ExclusionPrefs> {
  cached = { ...cached, [key]: next }
  loaded = true
  try {
    const { data: existing } = await supabase
      .from('user_settings')
      .select('id')
      .limit(1)
      .single()
    // WRITE ALL THREE COLUMNS, always — one fixed literal shape.
    //
    // Two earlier attempts failed the Supabase client's type checks: a computed
    // key ({ [COLUMN_OF[key]]: next }) produces an index signature, and a
    // per-key ternary produces a UNION of three shapes, which TS pins to
    // whichever branch comes first. A single literal with every column has
    // neither problem.
    //
    // `cached` was updated with the new value at the top of this function, so
    // writing the whole object persists exactly the state the UI is showing —
    // and it means the stored row can never drift from the cache, which the
    // per-column write could allow if one write failed and another succeeded.
    const patch = {
      show_permanent_leavers: cached.showPermanentLeavers,
      show_returned_leavers: cached.showReturnedLeavers,
      show_throwers: cached.showThrowers,
    }

    if (existing) {
      await supabase
        .from('user_settings')
        .update(patch)
        .eq('id', (existing as { id: number }).id)
    } else {
      await supabase
        .from('user_settings')
        .insert(patch)
    }
  } catch {
    /* keep the cache value even if the write fails; it re-syncs on next load */
  }
  return cached
}

/** The columns a row needs for this module to classify it correctly.
 *  Any surface that filters on exclusions must SELECT these — a row missing
 *  them falls back to the degraded path documented on isExcludedGame(). */
export const EXCLUSION_COLS =
  'team_leaver, enemy_leaver, team_leaver_type, enemy_leaver_type, team_thrower, enemy_thrower'

export interface ExcludableRow {
  team_leaver?: boolean | null
  enemy_leaver?: boolean | null
  team_leaver_type?: string | null
  enemy_leaver_type?: string | null
  team_thrower?: boolean | null
  enemy_thrower?: boolean | null
}

/**
 * Should this row be hidden under the current preferences?
 *
 * A match can carry more than one reason at once (a leaver AND a thrower, or a
 * leaver on each team). It is shown only if EVERY reason it carries is switched
 * on: one active exclusion is enough to hide it. Any other rule would let a
 * thrown game reappear because it also happened to have a leaver.
 *
 * ⚠️ DEGRADED PATH — a row carrying the leaver BOOLEANS but not the TYPE
 * columns cannot distinguish permanent from returned, because the boolean is
 * true for both. Such a row is treated as a PERMANENT leaver. That is the
 * conservative reading and it is correct for historical data: every one of the
 * 192 seeded rows was 'left', because the old boolean genuinely could not
 * express anything else. It would be WRONG for a future returned leaver, which
 * is why every surface that filters must select EXCLUSION_COLS rather than rely
 * on this. The fallback exists so that a missed column list degrades to
 * OVER-hiding rather than to showing distorted data as though it were clean.
 */
export function isExcludedGame(row: ExcludableRow): boolean {
  const p = cached

  const hasTypes = row.team_leaver_type != null || row.enemy_leaver_type != null
  const anyLeaverBool = row.team_leaver === true || row.enemy_leaver === true

  if (hasTypes) {
    const types = [row.team_leaver_type, row.enemy_leaver_type]
    if (!p.showPermanentLeavers && types.includes('left')) return true
    if (!p.showReturnedLeavers && types.includes('returned')) return true
  } else if (anyLeaverBool) {
    // Degraded: boolean only. Treated as permanent — see the warning above.
    if (!p.showPermanentLeavers) return true
  }

  if (!p.showThrowers && (row.team_thrower === true || row.enemy_thrower === true)) return true

  return false
}

/** Array form of isExcludedGame. Rows carrying none of these columns are kept,
 *  which is correct for scoreboard-derived rows that have no leaver data. */
export function keepIncluded<T extends ExcludableRow>(rows: T[]): T[] {
  return rows.filter(r => !isExcludedGame(r))
}
