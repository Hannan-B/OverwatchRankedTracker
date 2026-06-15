// ============================================================
// TIME LIB — aggregations for the Time page: streaks, sessions,
// time-of-day, game-length, and within-session / total-playtime decay.
// ------------------------------------------------------------
// Pure logic, no React (testable in isolation, mirrors outcomes/feel style).
//
// All match-grain, read straight off `matches`. EVERYTHING here assumes the
// rows are sorted CHRONOLOGICALLY (oldest → newest) by played_at before being
// passed in — streaks, sessions and decay are all order-dependent. The page
// loads ascending and the helpers re-sort defensively anyway.
//
// Conventions (shared with the rest of the app):
//   • Win rate = wins / (wins + losses); DRAWS EXCLUDED from the %, counted in N.
//   • Nothing dropped for sparsity; callers dim < minGames (default MIN_GAMES) as a confidence cue.
//   • Time is read from played_at in the viewer's LOCAL timezone (same as the
//     day-of-week chart on Outcomes), via the JS Date object.
//
// SESSION DEFINITION (user decision, this build): a gap of 45+ minutes between
// two consecutive matches starts a NEW session. NOTE this is deliberately
// DIFFERENT from the generic builder's 60-min convention — the user chose 45
// specifically for this page. Kept as a named constant so it's obviously
// intentional, not a typo.
// ============================================================

export type Result = 'victory' | 'defeat' | 'draw'
export const MIN_GAMES = 5

// The session-boundary gap, in minutes. 45+ min between matches = new session.
// Deliberately not the builder's 60 — see header note.
export const SESSION_GAP_MINUTES = 45
export const SESSION_GAP_MS = SESSION_GAP_MINUTES * 60 * 1000

// The match row this lib needs (subset of `matches`).
export interface TimeMatch {
  id: number
  result: Result | null
  played_at: string | null
  game_length_seconds: number | null
  season_id: number | null
}

// A season row (subset of the `seasons` table). Used for grouping/banding the
// week chart. start_date/end_date are `date` columns (no timezone).
export interface SeasonRow {
  id: number
  name: string
  start_date: string
  end_date: string
}

// ---- duration formatting (shared rule, this build) ----
// >= 60 min → "h:mm" (e.g. 1:25). < 60 min → "mm" with an 'm' suffix (e.g. 45m).
// Input is MINUTES (may be fractional; rounded to whole minutes first).
export function formatDuration(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—'
  const mins = Math.round(minutes)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

// ---- win-rate primitives (same shape as feel-lib / outcomes) ----
export interface Tally { wins: number; losses: number; draws: number }
export function emptyTally(): Tally { return { wins: 0, losses: 0, draws: 0 } }
export function add(t: Tally, r: Result | null) {
  if (r === 'victory') t.wins++
  else if (r === 'defeat') t.losses++
  else if (r === 'draw') t.draws++
}
export function winRate(t: Tally): number | null {
  const decisive = t.wins + t.losses
  return decisive > 0 ? Math.round((t.wins / decisive) * 1000) / 10 : null
}
export function games(t: Tally): number { return t.wins + t.losses + t.draws }

// A generic categorical win-rate row (matches the Outcomes CatRow shape so the
// shared WinRateBars component can render it directly).
export interface CatRow {
  key: string
  winRate: number | null
  games: number
  lowConfidence: boolean
  belowAverage?: boolean   // used by the decay charts to flag the decay point
}

// Parse played_at → epoch ms, or null if missing/unparseable. Centralised so
// every time computation rejects bad timestamps identically.
export function parseTime(played_at: string | null): number | null {
  if (!played_at) return null
  const t = new Date(played_at).getTime()
  return Number.isNaN(t) ? null : t
}

// Defensive chronological sort (oldest → newest). Rows without a valid
// timestamp are dropped (they can't be placed in a sequence/session).
export function sortChronological(rows: TimeMatch[]): TimeMatch[] {
  return rows
    .filter(r => parseTime(r.played_at) != null)
    .sort((a, b) => parseTime(a.played_at)! - parseTime(b.played_at)!)
}

// ============================================================
// STREAKS — longest win streak, longest loss streak, current streak.
// Draws BREAK a streak (they're neither a win nor a loss) — a draw ends the
// current run without extending either a win or a loss streak.
// ============================================================
export interface StreakSummary {
  longestWin: number
  longestLoss: number
  current: number          // signed: + = win streak, − = loss streak, 0 = none
  currentKind: 'win' | 'loss' | 'none'
  decided: number          // games counted toward streaks (wins+losses)
}

export function streaks(rows: TimeMatch[]): StreakSummary {
  const ordered = sortChronological(rows)
  let longestWin = 0
  let longestLoss = 0
  let runKind: 'win' | 'loss' | 'none' = 'none'
  let runLen = 0
  let decided = 0
  let curKind: 'win' | 'loss' | 'none' = 'none'
  let curLen = 0

  for (const r of ordered) {
    if (r.result === 'victory') {
      decided++
      if (runKind === 'win') runLen++
      else { runKind = 'win'; runLen = 1 }
      if (runLen > longestWin) longestWin = runLen
      curKind = 'win'; curLen = runLen
    } else if (r.result === 'defeat') {
      decided++
      if (runKind === 'loss') runLen++
      else { runKind = 'loss'; runLen = 1 }
      if (runLen > longestLoss) longestLoss = runLen
      curKind = 'loss'; curLen = runLen
    } else {
      // draw (or null) breaks the run
      runKind = 'none'; runLen = 0
      curKind = 'none'; curLen = 0
    }
  }

  return {
    longestWin,
    longestLoss,
    current: curKind === 'win' ? curLen : curKind === 'loss' ? -curLen : 0,
    currentKind: curKind,
    decided,
  }
}

// ============================================================
// SESSIONS — split the chronological sequence on SESSION_GAP_MINUTES gaps.
// Each session carries its matches (in order), so downstream decay logic can
// index position-in-session and time-into-session per session.
// ============================================================
export interface Session {
  index: number            // 0-based session number (chronological)
  matches: TimeMatch[]
  startMs: number
  endMs: number
  durationMinutes: number  // last match start − first match start (start-to-start)
}

export function buildSessions(rows: TimeMatch[]): Session[] {
  const ordered = sortChronological(rows)
  const sessions: Session[] = []
  let cur: TimeMatch[] = []
  let prevMs: number | null = null

  const flush = () => {
    if (cur.length === 0) return
    const startMs = parseTime(cur[0].played_at)!
    const endMs = parseTime(cur[cur.length - 1].played_at)!
    sessions.push({
      index: sessions.length,
      matches: cur,
      startMs,
      endMs,
      durationMinutes: Math.round((endMs - startMs) / 60000),
    })
    cur = []
  }

  for (const r of ordered) {
    const ms = parseTime(r.played_at)!
    if (prevMs != null && ms - prevMs >= SESSION_GAP_MS) flush()
    cur.push(r)
    prevMs = ms
  }
  flush()
  return sessions
}

// Session overview stats — headline numbers only. (The per-session bar chart
// was removed in favour of week trends + heatmaps; only the summary remains.)
export interface SessionOverview {
  sessionCount: number
  totalGames: number
  avgGamesPerSession: number | null
  avgSessionMinutes: number | null
  longestSessionGames: number
}

export function sessionOverview(rows: TimeMatch[]): SessionOverview {
  const sessions = buildSessions(rows)
  const totalGames = sessions.reduce((a, s) => a + s.matches.length, 0)
  const avg = (arr: number[]) =>
    arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null
  return {
    sessionCount: sessions.length,
    totalGames,
    avgGamesPerSession: avg(sessions.map(s => s.matches.length)),
    avgSessionMinutes: avg(sessions.map(s => s.durationMinutes)),
    longestSessionGames: sessions.reduce((mx, s) => Math.max(mx, s.matches.length), 0),
  }
}

// ============================================================
// TIME-OF-DAY — win rate by named hour block (local time). Ordered, not
// win-rate-sorted, so the scale reads chronologically across the day.
// ============================================================
export interface TimeBlock { label: string; startHour: number; endHour: number } // [start,end)
export const TIME_BLOCKS: TimeBlock[] = [
  { label: 'Late night (12–6am)', startHour: 0, endHour: 6 },
  { label: 'Morning (6am–12pm)', startHour: 6, endHour: 12 },
  { label: 'Afternoon (12–5pm)', startHour: 12, endHour: 17 },
  { label: 'Evening (5–9pm)', startHour: 17, endHour: 21 },
  { label: 'Night (9pm–12am)', startHour: 21, endHour: 24 },
]

export function winRateByTimeBlock(rows: TimeMatch[], minGames: number = MIN_GAMES): CatRow[] {
  const tallies = TIME_BLOCKS.map(() => emptyTally())
  for (const r of rows) {
    const ms = parseTime(r.played_at)
    if (ms == null) continue
    const hour = new Date(ms).getHours() // local hour 0–23
    const idx = TIME_BLOCKS.findIndex(b => hour >= b.startHour && hour < b.endHour)
    if (idx >= 0) add(tallies[idx], r.result)
  }
  return TIME_BLOCKS.map((b, i) => ({
    key: b.label,
    winRate: winRate(tallies[i]),
    games: games(tallies[i]),
    lowConfidence: games(tallies[i]) < minGames,
  }))
}

// ============================================================
// GAME-LENGTH — win rate by match-duration bucket. Ordered short → long.
// game_length_seconds is nullable; missing-length games are skipped here.
// ============================================================
export interface LengthBucket { label: string; minSec: number; maxSec: number } // [min,max)
export const LENGTH_BUCKETS: LengthBucket[] = [
  { label: '< 7 min', minSec: 0, maxSec: 7 * 60 },
  { label: '7–10 min', minSec: 7 * 60, maxSec: 10 * 60 },
  { label: '10–13 min', minSec: 10 * 60, maxSec: 13 * 60 },
  { label: '13–16 min', minSec: 13 * 60, maxSec: 16 * 60 },
  { label: '16+ min', minSec: 16 * 60, maxSec: Infinity },
]

export function winRateByGameLength(rows: TimeMatch[], minGames: number = MIN_GAMES): CatRow[] {
  const tallies = LENGTH_BUCKETS.map(() => emptyTally())
  for (const r of rows) {
    const s = r.game_length_seconds
    if (s == null || s <= 0) continue
    const idx = LENGTH_BUCKETS.findIndex(b => s >= b.minSec && s < b.maxSec)
    if (idx >= 0) add(tallies[idx], r.result)
  }
  return LENGTH_BUCKETS.map((b, i) => ({
    key: b.label,
    winRate: winRate(tallies[i]),
    games: games(tallies[i]),
    lowConfidence: games(tallies[i]) < minGames,
  }))
}

// ============================================================
// OVERALL WIN RATE — the baseline the decay charts compare against.
// Same convention: draws excluded from the %, counted in N.
// ============================================================
export function overallWinRate(rows: TimeMatch[]): number | null {
  const t = emptyTally()
  for (const r of rows) add(t, r.result)
  return winRate(t)
}

// Flag the FIRST bucket (in display order) whose win rate drops below the
// overall average — the "decay point". Only buckets with enough confidence
// (>= MIN_GAMES) and a real win rate can be flagged, so a sparse early bucket
// doesn't get spuriously called the decay point. Returns a NEW array; the
// flagged row (and every row after it, since decay persists) gets belowAverage.
export function flagDecayPoint(rows: CatRow[], overall: number | null): CatRow[] {
  if (overall == null) return rows.map(r => ({ ...r, belowAverage: false }))
  let found = false
  return rows.map(r => {
    if (!found && !r.lowConfidence && r.winRate != null && r.winRate < overall) {
      found = true
    }
    return { ...r, belowAverage: found }
  })
}

// ============================================================
// WITHIN-SESSION DECAY — two views, both built per-session then pooled.
//   (A) by game POSITION in the session (1st, 2nd, 3rd, …)
//   (B) by TIME ELAPSED into the session (minutes since the session's 1st game)
// ============================================================

// (A) Position-in-session. Buckets the tail so a few very long sessions don't
// create lots of n=1 columns. Positions 1..6 explicit, then "7+".
export const POSITION_BUCKETS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th+']
export function winRateByPositionInSession(rows: TimeMatch[], minGames: number = MIN_GAMES): CatRow[] {
  const sessions = buildSessions(rows)
  const tallies = POSITION_BUCKETS.map(() => emptyTally())
  for (const s of sessions) {
    s.matches.forEach((m, i) => {
      const idx = Math.min(i, POSITION_BUCKETS.length - 1)
      add(tallies[idx], m.result)
    })
  }
  return POSITION_BUCKETS.map((label, i) => ({
    key: label,
    winRate: winRate(tallies[i]),
    games: games(tallies[i]),
    lowConfidence: games(tallies[i]) < minGames,
  }))
}

// (B) Time-elapsed into session. Bucketed by minutes since the session start.
export const ELAPSED_BUCKETS: { label: string; minMin: number; maxMin: number }[] = [
  { label: 'First 30 min', minMin: 0, maxMin: 30 },
  { label: '30–60 min', minMin: 30, maxMin: 60 },
  { label: '1–2 hr', minMin: 60, maxMin: 120 },
  { label: '2–3 hr', minMin: 120, maxMin: 180 },
  { label: '3 hr+', minMin: 180, maxMin: Infinity },
]
export function winRateByTimeIntoSession(rows: TimeMatch[], minGames: number = MIN_GAMES): CatRow[] {
  const sessions = buildSessions(rows)
  const tallies = ELAPSED_BUCKETS.map(() => emptyTally())
  for (const s of sessions) {
    for (const m of s.matches) {
      const elapsedMin = (parseTime(m.played_at)! - s.startMs) / 60000
      const idx = ELAPSED_BUCKETS.findIndex(b => elapsedMin >= b.minMin && elapsedMin < b.maxMin)
      if (idx >= 0) add(tallies[idx], m.result)
    }
  }
  return ELAPSED_BUCKETS.map((b, i) => ({
    key: b.label,
    winRate: winRate(tallies[i]),
    games: games(tallies[i]),
    lowConfidence: games(tallies[i]) < minGames,
  }))
}

// ============================================================
// DECAY POINT — the user's headline question: "if I play for 2–3 hrs do I
// start losing more?" Two framings, each flagged against the overall average:
//   (1) by HOURS played into the session (reuses the elapsed buckets)
//   (2) by GAMES DEEP into the session (reuses the position buckets, coarser)
// Both return CatRows with belowAverage set from the decay point onward.
// ============================================================

// (1) by hours played — same elapsed buckets, flagged.
export function decayByHoursPlayed(rows: TimeMatch[]): CatRow[] {
  const base = winRateByTimeIntoSession(rows)
  return flagDecayPoint(base, overallWinRate(rows))
}

// (2) by games deep — coarser game-depth buckets, flagged.
export const DEPTH_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: 'Games 1–3', min: 1, max: 3 },
  { label: 'Games 4–6', min: 4, max: 6 },
  { label: 'Games 7–9', min: 7, max: 9 },
  { label: 'Games 10+', min: 10, max: Infinity },
]
export function decayByGamesDeep(rows: TimeMatch[], minGames: number = MIN_GAMES): CatRow[] {
  const sessions = buildSessions(rows)
  const tallies = DEPTH_BUCKETS.map(() => emptyTally())
  for (const s of sessions) {
    s.matches.forEach((m, i) => {
      const depth = i + 1 // 1-based game number within the session
      const idx = DEPTH_BUCKETS.findIndex(b => depth >= b.min && depth <= b.max)
      if (idx >= 0) add(tallies[idx], m.result)
    })
  }
  const base = DEPTH_BUCKETS.map((b, i) => ({
    key: b.label,
    winRate: winRate(tallies[i]),
    games: games(tallies[i]),
    lowConfidence: games(tallies[i]) < minGames,
  }))
  return flagDecayPoint(base, overallWinRate(rows))
}

// ============================================================
// CALENDAR HELPERS — local-time week and month keys.
// ------------------------------------------------------------
// Week: ISO-8601 week (Mon-started, the week containing the year's first
// Thursday is week 1). Returns { year, week } where `year` is the ISO week-year
// (can differ from the calendar year in late Dec / early Jan). A sortable key
// "YYYY-Www" and a short label are derived from it.
// Month: calendar month in local time → { year, month } + "YYYY-MM" key.
// ============================================================

export interface WeekKey {
  year: number
  week: number
  key: string            // "YYYY-Www" sortable
  label: string          // "W20 · 11/05" — week number anchored to its Monday date
  dateLabel: string      // "11/05" — the week's Monday as dd/mm
}

export function isoWeek(d: Date): WeekKey {
  // Copy to avoid mutating; work in local time (matches the rest of the page).
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  // The Monday that starts this calendar week (Mon=0..Sun=6 offset).
  const dowMon0 = (date.getDay() + 6) % 7
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - dowMon0)
  // ISO: Thursday determines the week-year. Shift to the Thursday of this week.
  const day = (date.getDay() + 6) % 7 // Mon=0..Sun=6
  date.setDate(date.getDate() - day + 3) // move to Thursday
  const firstThursday = new Date(date.getFullYear(), 0, 4)
  const firstDay = (firstThursday.getDay() + 6) % 7
  firstThursday.setDate(firstThursday.getDate() - firstDay + 3)
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000))
  const year = date.getFullYear()
  const key = `${year}-W${String(week).padStart(2, '0')}`
  const dd = String(monday.getDate()).padStart(2, '0')
  const mm = String(monday.getMonth() + 1).padStart(2, '0')
  const dateLabel = `${dd}/${mm}`
  return { year, week, key, label: `W${week} · ${dateLabel}`, dateLabel }
}

export interface MonthKey { year: number; month: number; key: string; label: string }
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function monthKey(d: Date): MonthKey {
  const year = d.getFullYear()
  const month = d.getMonth() // 0-based
  return {
    year, month,
    key: `${year}-${String(month + 1).padStart(2, '0')}`,
    label: `${MONTH_LABELS[month]} ${String(year).slice(2)}`,
  }
}

// ============================================================
// WIN RATE BY WEEK — grouped by SEASON.
// ------------------------------------------------------------
// Each match is placed in a season by its season_id (authoritative — we do NOT
// re-derive season from dates, to avoid timezone edge cases at boundaries and
// to respect explicit assignment). Matches with season_id = null are grouped
// under "Unassigned" so they're never dropped.
//
// EMPTY-SEASONS FALLBACK: when no seasons exist yet (seasons table empty), every
// match has season_id = null, so the whole feed lands in ONE group. The page
// labels that single group "All time" rather than "Unassigned" (see page). The
// small-multiples view degenerates to one panel; toggles/banding don't render.
// Once seasons exist and matches carry season_id, the SAME structure splits into
// per-season groups automatically.
//
// Within a group, weeks are emitted in chronological order across the group's
// span (gaps where no games were played are SKIPPED — we only emit weeks that
// have at least one game, so a long break doesn't create dozens of empty bars).
// ============================================================

export interface WeekPoint {
  key: string            // "YYYY-Www" sortable
  label: string          // "W20 · 11/05" — week number + that week's Monday (dd/mm)
  winRate: number | null
  games: number
  lowConfidence: boolean
}

export interface SeasonWeekGroup {
  seasonId: number | null
  seasonName: string     // resolved by caller; "Unassigned"/"All time" for null
  startMs: number        // earliest game in the group (for banding/ordering)
  endMs: number          // latest game in the group
  weeks: WeekPoint[]
  totalGames: number
}

// rows: the (filtered) matches. seasonName: id → name resolver (from `seasons`).
// nullLabel: what to call the season_id = null bucket ("All time" when there are
// no seasons at all, else "Unassigned").
export function winRateByWeekPerSeason(
  rows: TimeMatch[],
  seasonName: (id: number | null) => string,
  minGames: number = MIN_GAMES,
): SeasonWeekGroup[] {
  // bucket matches by season_id
  const bySeason = new Map<number | null, TimeMatch[]>()
  for (const r of rows) {
    const ms = parseTime(r.played_at)
    if (ms == null) continue
    const sid = r.season_id ?? null
    if (!bySeason.has(sid)) bySeason.set(sid, [])
    bySeason.get(sid)!.push(r)
  }

  const groups: SeasonWeekGroup[] = []
  for (const [sid, matches] of bySeason.entries()) {
    // tally by ISO week
    const byWeek = new Map<string, { label: string; t: Tally }>()
    let startMs = Infinity
    let endMs = -Infinity
    for (const m of matches) {
      const ms = parseTime(m.played_at)!
      if (ms < startMs) startMs = ms
      if (ms > endMs) endMs = ms
      const wk = isoWeek(new Date(ms))
      if (!byWeek.has(wk.key)) byWeek.set(wk.key, { label: wk.label, t: emptyTally() })
      add(byWeek.get(wk.key)!.t, m.result)
    }
    const weeks: WeekPoint[] = Array.from(byWeek.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, v]) => ({
        key, label: v.label,
        winRate: winRate(v.t), games: games(v.t),
        lowConfidence: games(v.t) < minGames,
      }))
    groups.push({
      seasonId: sid,
      seasonName: seasonName(sid),
      startMs, endMs,
      weeks,
      totalGames: matches.length,
    })
  }
  // order groups chronologically by their first game
  return groups.sort((a, b) => a.startMs - b.startMs)
}

// ============================================================
// AVERAGE SESSION PER MONTH — two series: avg minutes and avg games / session.
// One row per calendar month that has at least one session. A session is
// attributed to the month of its FIRST game (its start).
// ============================================================
export interface MonthSessionRow {
  key: string            // "YYYY-MM"
  label: string          // "May 26"
  avgMinutes: number | null
  avgGames: number | null
  sessions: number
  lowConfidence: boolean // < minGames (default MIN_GAMES) sessions in the month
}

export function avgSessionPerMonth(rows: TimeMatch[], minGames: number = MIN_GAMES): MonthSessionRow[] {
  const sessions = buildSessions(rows)
  // group sessions by the month of their start
  const byMonth = new Map<string, { label: string; minutes: number[]; games: number[] }>()
  for (const s of sessions) {
    const mk = monthKey(new Date(s.startMs))
    if (!byMonth.has(mk.key)) byMonth.set(mk.key, { label: mk.label, minutes: [], games: [] })
    const b = byMonth.get(mk.key)!
    b.minutes.push(s.durationMinutes)
    b.games.push(s.matches.length)
  }
  const avg = (arr: number[]) =>
    arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null
  return Array.from(byMonth.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, v]) => ({
      key, label: v.label,
      avgMinutes: avg(v.minutes),
      avgGames: avg(v.games),
      sessions: v.minutes.length,
      lowConfidence: v.minutes.length < minGames,
    }))
}

// ============================================================
// HEATMAPS — a generic win-rate grid: rows × cols, each cell a Tally.
// Cells carry winRate + games (n) + lowConfidence so the page can colour by
// win rate AND print n in-cell, dimming sparse cells.
// ============================================================
export interface HeatCell {
  rowKey: string
  colKey: string
  winRate: number | null
  games: number
  lowConfidence: boolean
}
export interface Heatmap {
  rowLabels: string[]
  colLabels: string[]
  cells: HeatCell[]      // row-major; rowLabels.length × colLabels.length
}

function buildHeatmap(
  rows: TimeMatch[],
  rowOf: (m: TimeMatch, ms: number) => string | null,
  colOf: (m: TimeMatch, ms: number) => string | null,
  rowLabels: string[],
  colLabels: string[],
  minGames: number = MIN_GAMES,
): Heatmap {
  const grid = new Map<string, Tally>()
  const cellKey = (r: string, c: string) => `${r}\u0000${c}`
  for (const r of rowLabels) for (const c of colLabels) grid.set(cellKey(r, c), emptyTally())
  for (const m of rows) {
    const ms = parseTime(m.played_at)
    if (ms == null) continue
    const rk = rowOf(m, ms)
    const ck = colOf(m, ms)
    if (rk == null || ck == null) continue
    const cell = grid.get(cellKey(rk, ck))
    if (cell) add(cell, m.result)
  }
  const cells: HeatCell[] = []
  for (const rk of rowLabels) {
    for (const ck of colLabels) {
      const t = grid.get(cellKey(rk, ck))!
      cells.push({
        rowKey: rk, colKey: ck,
        winRate: winRate(t), games: games(t),
        lowConfidence: games(t) < minGames,
      })
    }
  }
  return { rowLabels, colLabels, cells }
}

// (1) Day of week (Mon→Sun) × time-of-day block.
const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export function heatmapDayByTimeOfDay(rows: TimeMatch[], minGames: number = MIN_GAMES): Heatmap {
  const blockLabels = TIME_BLOCKS.map(b => b.label)
  return buildHeatmap(
    rows,
    (_m, ms) => DOW_LABELS[(new Date(ms).getDay() + 6) % 7],
    (_m, ms) => {
      const hour = new Date(ms).getHours()
      const b = TIME_BLOCKS.find(b => hour >= b.startHour && hour < b.endHour)
      return b ? b.label : null
    },
    DOW_LABELS,
    blockLabels,
    minGames,
  )
}

// (2) Week × day — a calendar-style grid. Rows are the ISO weeks present in the
// data (chronological), cols are Mon→Sun. Only weeks with games are emitted.
// Rows DISPLAY the friendly "W20 · 11/05" label (week number + that week's
// Monday date) rather than the opaque sortable key.
export function heatmapWeekByDay(rows: TimeMatch[], minGames: number = MIN_GAMES): Heatmap {
  // discover the weeks present, in chronological order, mapping key → label.
  const keyToLabel = new Map<string, string>()
  const orderedKeys: string[] = []
  for (const m of rows) {
    const ms = parseTime(m.played_at)
    if (ms == null) continue
    const wk = isoWeek(new Date(ms))
    if (!keyToLabel.has(wk.key)) { keyToLabel.set(wk.key, wk.label); orderedKeys.push(wk.key) }
  }
  orderedKeys.sort((a, b) => a.localeCompare(b))
  const weekLabels = orderedKeys.map(k => keyToLabel.get(k)!)
  return buildHeatmap(
    rows,
    (_m, ms) => keyToLabel.get(isoWeek(new Date(ms)).key) ?? null, // row = friendly label
    (_m, ms) => DOW_LABELS[(new Date(ms).getDay() + 6) % 7],
    weekLabels,
    DOW_LABELS,
    minGames,
  )
}

// (3) Session length × games-in-session. Each MATCH is attributed to the bucket
// of the session it belongs to (so a cell asks: "in sessions of THIS shape, how
// do my games go?"). Length buckets by session duration; games buckets by how
// many games the session contains.
export const SESSION_LENGTH_BUCKETS: { label: string; minMin: number; maxMin: number }[] = [
  { label: '< 30m', minMin: 0, maxMin: 30 },
  { label: '30–60m', minMin: 30, maxMin: 60 },
  { label: '1–2h', minMin: 60, maxMin: 120 },
  { label: '2h+', minMin: 120, maxMin: Infinity },
]
export const SESSION_GAMES_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: '1–2 games', min: 1, max: 2 },
  { label: '3–5 games', min: 3, max: 5 },
  { label: '6–9 games', min: 6, max: 9 },
  { label: '10+ games', min: 10, max: Infinity },
]
export function heatmapSessionShape(rows: TimeMatch[], minGames: number = MIN_GAMES): Heatmap {
  const sessions = buildSessions(rows)
  // map each match id → its session's (lengthLabel, gamesLabel)
  const lenOf = (mins: number) =>
    SESSION_LENGTH_BUCKETS.find(b => mins >= b.minMin && mins < b.maxMin)?.label ?? null
  const gamesOf = (n: number) =>
    SESSION_GAMES_BUCKETS.find(b => n >= b.min && n <= b.max)?.label ?? null
  const matchShape = new Map<number, { len: string | null; gms: string | null }>()
  for (const s of sessions) {
    const len = lenOf(s.durationMinutes)
    const gms = gamesOf(s.matches.length)
    for (const m of s.matches) matchShape.set(m.id, { len, gms })
  }
  const lengthLabels = SESSION_LENGTH_BUCKETS.map(b => b.label)
  const gamesLabels = SESSION_GAMES_BUCKETS.map(b => b.label)
  return buildHeatmap(
    rows,
    m => matchShape.get(m.id)?.len ?? null,    // row = session length
    m => matchShape.get(m.id)?.gms ?? null,    // col = games in session
    lengthLabels,
    gamesLabels,
    minGames,
  )
}
