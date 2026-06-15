// ============================================================
// SEASON FILTER UTIL — shared default-selection logic
// ------------------------------------------------------------
// The analytics season filter defaults to the CURRENT season (the one whose date
// range covers today), falling back to All Time ([]) when no current season
// exists — e.g. before any real seasons are set up, when every match is
// season_id = null. Centralised so all six season-aware pages behave identically.
//
// Returns the default `seasons` array for AnalyticsFilterState:
//   • current season found → [currentId]
//   • no current season    → []  (All Time)
//
// `id` is accepted as number | string (Home types season ids as string; the
// analytics pages as number) and normalised to number for the filter state.

export interface SeasonLike {
  id: number | string
  start_date: string
  end_date: string
}

/** The id (as number) of the season whose range covers `today`, or null. */
export function currentSeasonId(
  seasons: SeasonLike[],
  today: Date = new Date(),
): number | null {
  const t = today.toISOString().slice(0, 10) // YYYY-MM-DD, compared lexically
  const cur = seasons.find(s => s.start_date <= t && t <= s.end_date)
  return cur == null ? null : Number(cur.id)
}

/** Default `seasons` selection: [currentId] when a current season exists, else []. */
export function defaultSeasonSelection(
  seasons: SeasonLike[],
  today: Date = new Date(),
): number[] {
  const id = currentSeasonId(seasons, today)
  return id == null ? [] : [id]
}
