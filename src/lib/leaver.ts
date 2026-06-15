import { supabase } from '@/lib/supabase'

// ============================================================
// LEAVER-GAME VISIBILITY — single source of truth
// ============================================================
//
// A "leaver game" is any match where team_leaver OR enemy_leaver is true. Its
// scoreboard couldn't be read (a leaver collapses the layout), so it carries no
// scoreboard_players rows — only the match record + hero breakdowns.
//
// Leaver games DISTORT the performance surfaces (a 5v6 result isn't a fair read
// of your play), so by default they're EXCLUDED from: Outcomes, Combat, Time,
// Heroes, Matchups, Pairings. A single switch (this file) flips them back in.
//
//   EXEMPT — always see all games regardless of the switch:
//     • Feel  — its leaver/thrower charts exist to analyse leaver games.
//     • Builder — leaver is a selectable variable there.
//     • The overview leaver callout boxes — they count leaver games on purpose.
//
// Unlike alpha (a localhost-only dev control in localStorage), this is a real
// user preference that applies on LIVE too and should follow you across devices,
// so it lives in user_settings.show_leaver_games.
//
// SYNC READ-SIDE: the analytics read-side is synchronous (filters run inline,
// no awaiting). A DB value can't be read synchronously, so we load it ONCE into
// a module-level cache and read the cache synchronously thereafter:
//   • loadLeaverPref()      — async; call once on app/page load to fill the cache
//   • showLeaverGames()     — sync; reads the cache (default false until loaded)
//   • setShowLeaverGames()  — async; writes DB + cache (immediate local effect)
//   • keepNonLeaver(rows)   — sync; drops leaver rows unless the switch is on
//   • excludeLeaversInQuery — sync; pushes the rule into a matches query builder
//
// COLD-LOAD DEFAULT: before loadLeaverPref() resolves the cache is false, i.e.
// leaver games are HIDDEN. That's the safe default (a brief flash of "hidden"
// is better than briefly showing distorted data).

// Module-level cache. false = hide leaver games (the default).
let cachedShow = false
let loaded = false

/**
 * Load the preference from user_settings into the cache. Call once on app/page
 * load (e.g. in a top-level effect). Safe to call repeatedly — it just refreshes
 * the cache. Never throws; on any error the cache stays at its safe default.
 */
export async function loadLeaverPref(): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('user_settings')
      .select('show_leaver_games')
      .limit(1)
      .single()
    cachedShow = (data as { show_leaver_games?: boolean | null } | null)?.show_leaver_games === true
  } catch {
    cachedShow = false
  }
  loaded = true
  return cachedShow
}

/** Has the preference been loaded from the DB yet this session? */
export function leaverPrefLoaded(): boolean {
  return loaded
}

/**
 * Should leaver games be visible right now (on the performance surfaces)?
 * Reads the cache synchronously. Defaults to false until loadLeaverPref() runs.
 */
export function showLeaverGames(): boolean {
  return cachedShow
}

/**
 * Flip the switch. Writes user_settings (so it syncs across devices) AND updates
 * the cache (so the current session reflects it immediately). Returns the new
 * value. Upserts the single user_settings row if it doesn't exist yet.
 */
export async function setShowLeaverGames(next: boolean): Promise<boolean> {
  cachedShow = next
  loaded = true
  try {
    const { data: existing } = await supabase
      .from('user_settings')
      .select('id')
      .limit(1)
      .single()
    if (existing) {
      await supabase
        .from('user_settings')
        .update({ show_leaver_games: next })
        .eq('id', (existing as { id: number }).id)
    } else {
      await supabase
        .from('user_settings')
        .insert({ show_leaver_games: next })
    }
  } catch {
    /* keep the cache value even if the write fails; it'll re-sync next load */
  }
  return cachedShow
}

/**
 * Drop leaver rows from an already-fetched array, unless the switch is on. For
 * view reads / hero-grain rows. The row must carry team_leaver / enemy_leaver;
 * a row missing both fields is treated as NOT a leaver game (kept), which is the
 * correct behaviour for scoreboard-based views that have no leaver rows anyway.
 *
 *   const visible = keepNonLeaver(rows)
 */
export function keepNonLeaver<
  T extends { team_leaver?: boolean | null; enemy_leaver?: boolean | null }
>(rows: T[]): T[] {
  if (showLeaverGames()) return rows
  return rows.filter(r => r.team_leaver !== true && r.enemy_leaver !== true)
}

/** True if a single row represents a leaver game. */
export function isLeaverRow(
  row: { team_leaver?: boolean | null; enemy_leaver?: boolean | null }
): boolean {
  return row.team_leaver === true || row.enemy_leaver === true
}
