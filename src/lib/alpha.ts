import { supabase } from '@/lib/supabase'

// ============================================================
// ALPHA / TEST-DATA VISIBILITY — single source of truth
// ============================================================
//
// Write side (already done in /process): matches are stamped is_alpha = true
// when saved on localhost, false on the live site.
//
// Read side (this file): decide whether alpha matches are SHOWN.
//   • Live site  → alpha is NEVER shown. Always excluded.
//   • Localhost  → alpha is shown or hidden according to ONE global switch,
//                  stored in localStorage and flipped from a dev toggle.
//
// Every match-reading query routes through here so the rule lives in exactly
// one place. Two ways to apply it depending on what a surface reads:
//   1. Pages that read the `matches` table directly → use matchQuery().
//   2. Pages that read SQL views carrying an is_alpha column → fetch all rows,
//      then filter with keepVisible() in the page (views can't tell localhost
//      from live, so the decision has to happen in JS).
//
// localStorage note: the switch is per-browser. That's fine — it's a personal
// dev control, not shared state.

const ALPHA_KEY = 'ow:showAlpha'

/** Are we running on localhost? (mirrors the /process write-side check) */
export function isLocalhost(): boolean {
  if (typeof window === 'undefined') return false // SSR → treat as live (safe default)
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0'
}

/**
 * Should alpha (test) matches be visible right now?
 * Live → always false. Localhost → whatever the global switch says (default false).
 */
export function showAlpha(): boolean {
  if (!isLocalhost()) return false
  try {
    return window.localStorage.getItem(ALPHA_KEY) === 'true'
  } catch {
    return false
  }
}

/** Flip the global switch (no-op off localhost). Returns the new value. */
export function setShowAlpha(next: boolean): boolean {
  if (!isLocalhost()) return false
  try {
    window.localStorage.setItem(ALPHA_KEY, next ? 'true' : 'false')
  } catch { /* ignore */ }
  return showAlpha()
}

/**
 * Build a SELECT against the `matches` table with the alpha rule applied.
 * Use for any query that reads `matches` directly.
 *
 *   matchQuery('id, played_at, map, season_id').order('played_at', ...)
 *
 * On live (or localhost with the switch off) this adds .eq('is_alpha', false).
 * On localhost with the switch on, no alpha filter is applied (you see all).
 *
 * Note on typing: the returned query result is typed as `any[]` rows so that the
 * CALLER keeps casting the result exactly as it did before, e.g.
 *   const { data } = await matchQuery('...').order(...)
 *   const rows = (data as MyRow[]) || []
 * This keeps the helper independent of your generated Supabase types.
 */
export function matchQuery(columns: string) {
  let q = supabase.from('matches').select(columns)
  if (!showAlpha()) q = q.eq('is_alpha', false)
  return q
}

/**
 * Filter already-fetched rows that carry an is_alpha field. Use for SQL views
 * that expose is_alpha (Hero Analytics card/breakdown views, etc.) where the
 * decision must happen in the page rather than in the query.
 *
 *   const visible = keepVisible(cardData)
 */
export function keepVisible<T extends { is_alpha?: boolean | null }>(rows: T[]): T[] {
  if (showAlpha()) return rows
  return rows.filter(r => r.is_alpha !== true)
}
