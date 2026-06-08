// ============================================================
// FEEL LIB — aggregations for the qualitative ("how did it feel?") fields.
// ------------------------------------------------------------
// Pure logic, no React (testable in isolation, mirrors outcomes/matchups style).
//
// All match-grain, read straight off `matches`:
//   fun_rating (1–5) · match_feel · performance_feel · tilt_mood
//   team_tempo / enemy_tempo · team_coordination / enemy_coordination
//   team_leaver / team_thrower / enemy_leaver / enemy_thrower (booleans)
//
// Conventions (shared with the rest of the app):
//   • Win rate = wins / (wins + losses); DRAWS EXCLUDED from the %, counted in N.
//   • Ordered enums keep their natural order (not sorted by win rate) so the
//     scale reads left→right; unordered cuts can sort by win rate.
//   • Nothing dropped for sparsity; callers dim < MIN_GAMES as a confidence cue.
// The role-aware "feel vs reality" stat cross is hero-grain and lives separately
// (see feelVsStats) because it joins match feel ↔ hero stats by match_id.
// ============================================================

export type Result = 'victory' | 'defeat' | 'draw'
export const MIN_GAMES = 5

export type MatchFeel = 'stomped_them' | 'close_game' | 'got_stomped'
export type PerformanceFeel = 'carried' | 'did_my_job' | 'struggled'
export type TiltMood = 'tilted' | 'annoyed' | 'fine' | 'good' | 'hyped'
export type Tempo = 'aggressive' | 'balanced' | 'passive'
export type Coordination = 'coordinated' | 'average' | 'chaotic'

// The match row this lib needs (subset of `matches`).
export interface FeelMatch {
  id: number
  result: Result | null
  fun_rating: number | null
  match_feel: MatchFeel | null
  performance_feel: PerformanceFeel | null
  tilt_mood: TiltMood | null
  team_tempo: Tempo | null
  enemy_tempo: Tempo | null
  team_coordination: Coordination | null
  enemy_coordination: Coordination | null
  team_leaver: boolean | null
  team_thrower: boolean | null
  enemy_leaver: boolean | null
  enemy_thrower: boolean | null
}

// Display order + labels for each enum (natural/ordered, not win-rate-sorted).
export const MATCH_FEEL_ORDER: MatchFeel[] = ['stomped_them', 'close_game', 'got_stomped']
export const PERF_FEEL_ORDER: PerformanceFeel[] = ['carried', 'did_my_job', 'struggled']
export const TILT_ORDER: TiltMood[] = ['tilted', 'annoyed', 'fine', 'good', 'hyped']
export const TEMPO_ORDER: Tempo[] = ['aggressive', 'balanced', 'passive']
export const COORD_ORDER: Coordination[] = ['coordinated', 'average', 'chaotic']

export const LABELS: Record<string, string> = {
  stomped_them: 'Stomped them', close_game: 'Close game', got_stomped: 'Got stomped',
  carried: 'Carried', did_my_job: 'Did my job', struggled: 'Struggled',
  tilted: 'Tilted', annoyed: 'Annoyed', fine: 'Fine', good: 'Good', hyped: 'Hyped',
  aggressive: 'Aggressive', balanced: 'Balanced', passive: 'Passive',
  coordinated: 'Coordinated', average: 'Average', chaotic: 'Chaotic',
}

// ---- win-rate primitives ----
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
export function mean(vals: (number | null)[]): number | null {
  const n = vals.filter((v): v is number => v != null)
  return n.length ? Math.round((n.reduce((a, b) => a + b, 0) / n.length) * 100) / 100 : null
}

// ---- A categorical "win rate per value" row ----
export interface CatRow {
  key: string          // the raw enum value (or label key)
  label: string        // display label
  winRate: number | null
  games: number
  wins: number
  losses: number
  draws: number
  lowConfidence: boolean
}

// ---- Result filter (Feel page) ----
// 'all' = no narrowing; otherwise restrict to one result. When a specific
// result is chosen, win-rate framing is meaningless (always 100%/0%), so the
// page switches win-rate charts to DISTRIBUTION (share of that result's games).
export type ResultFilter = 'all' | Result
export function applyResultFilter<T extends FeelMatch>(rows: T[], rf: ResultFilter): T[] {
  return rf === 'all' ? rows : rows.filter(r => r.result === rf)
}

// A distribution row: share of the (already result-filtered) games at each enum
// value, with the raw count. Order preserved (ordered scales).
export interface DistRow {
  key: string
  label: string
  pct: number | null   // % of games-with-this-field-set that fall in this value
  count: number        // games at this value
  total: number        // games with the field set at all (the denominator)
  lowConfidence: boolean
}
export function distByEnum<T extends string>(
  rows: FeelMatch[],
  field: (m: FeelMatch) => T | null,
  order: T[],
): DistRow[] {
  const counts = new Map<T, number>()
  for (const o of order) counts.set(o, 0)
  let total = 0
  for (const r of rows) {
    const v = field(r)
    if (v == null || !counts.has(v)) continue
    counts.set(v, counts.get(v)! + 1)
    total++
  }
  return order.map(o => {
    const count = counts.get(o)!
    return {
      key: o, label: LABELS[o] ?? o,
      pct: total > 0 ? Math.round((count / total) * 1000) / 10 : null,
      count, total, lowConfidence: count < MIN_GAMES,
    }
  })
}

// Combined team-vs-enemy DISTRIBUTION (for the filtered/transform view).
export interface TeamEnemyDistRow {
  key: string
  label: string
  teamPct: number | null
  enemyPct: number | null
  teamCount: number
  enemyCount: number
  lowConfidence: boolean
}
export function teamVsEnemyDist<T extends string>(
  rows: FeelMatch[],
  teamField: (m: FeelMatch) => T | null,
  enemyField: (m: FeelMatch) => T | null,
  order: T[],
): TeamEnemyDistRow[] {
  const team = distByEnum(rows, teamField, order)
  const enemy = distByEnum(rows, enemyField, order)
  return order.map((o, i) => ({
    key: o, label: LABELS[o] ?? o,
    teamPct: team[i].pct, enemyPct: enemy[i].pct,
    teamCount: team[i].count, enemyCount: enemy[i].count,
    lowConfidence: team[i].count < MIN_GAMES || enemy[i].count < MIN_GAMES,
  }))
}
export function winRateByEnum<T extends string>(
  rows: FeelMatch[],
  field: (m: FeelMatch) => T | null,
  order: T[],
): CatRow[] {
  const t = new Map<T, Tally>()
  for (const o of order) t.set(o, emptyTally())
  for (const r of rows) {
    const v = field(r)
    if (v == null || !t.has(v)) continue
    add(t.get(v)!, r.result)
  }
  return order.map(o => {
    const tt = t.get(o)!
    return {
      key: o, label: LABELS[o] ?? o, winRate: winRate(tt), games: games(tt),
      wins: tt.wins, losses: tt.losses, draws: tt.draws, lowConfidence: games(tt) < MIN_GAMES,
    }
  })
}

// ---- Fun rating ----
// Distribution: count of games at each star 1..5 (always all five buckets).
export interface FunBucket { star: number; count: number; lowConfidence: boolean }
export function funDistribution(rows: FeelMatch[]): FunBucket[] {
  const counts = [0, 0, 0, 0, 0]
  for (const r of rows) {
    const f = r.fun_rating
    if (f != null && f >= 1 && f <= 5) counts[f - 1]++
  }
  return counts.map((count, i) => ({ star: i + 1, count, lowConfidence: count < MIN_GAMES }))
}

// Average fun by result (win / loss / draw).
export interface AvgFunRow { result: Result; avgFun: number | null; games: number; lowConfidence: boolean }
export function avgFunByResult(rows: FeelMatch[]): AvgFunRow[] {
  const order: Result[] = ['victory', 'defeat', 'draw']
  return order.map(res => {
    const subset = rows.filter(r => r.result === res && r.fun_rating != null)
    return {
      result: res,
      avgFun: mean(subset.map(r => r.fun_rating)),
      games: subset.length,
      lowConfidence: subset.length < MIN_GAMES,
    }
  })
}

// Fun distribution split by result — for a stacked/grouped view.
// Returns one row per star with a count per result.
export interface FunByResultRow { star: number; victory: number; defeat: number; draw: number; total: number }
export function funByResult(rows: FeelMatch[]): FunByResultRow[] {
  const init = (): FunByResultRow => ({ star: 0, victory: 0, defeat: 0, draw: 0, total: 0 })
  const buckets = [1, 2, 3, 4, 5].map(s => { const b = init(); b.star = s; return b })
  for (const r of rows) {
    const f = r.fun_rating
    if (f == null || f < 1 || f > 5) continue
    const b = buckets[f - 1]
    if (r.result === 'victory') b.victory++
    else if (r.result === 'defeat') b.defeat++
    else if (r.result === 'draw') b.draw++
    b.total++
  }
  return buckets
}

// ---- Boolean flags (leaver / thrower): count + outcome, NOT a win-rate factor.
// For each flag, the games where it was true and how those games went.
export interface FlagOutcome {
  key: string
  label: string
  games: number       // games where the flag was true
  wins: number
  losses: number
  draws: number
  winRate: number | null
  lowConfidence: boolean
}
export function flagOutcome(rows: FeelMatch[], field: (m: FeelMatch) => boolean | null, key: string, label: string): FlagOutcome {
  const t = emptyTally()
  for (const r of rows) {
    if (field(r) === true) add(t, r.result)
  }
  return {
    key, label, games: games(t), wins: t.wins, losses: t.losses, draws: t.draws,
    winRate: winRate(t), lowConfidence: games(t) < MIN_GAMES,
  }
}

// All four flags as count+outcome rows (for the combined leaver/thrower view).
export function allFlagOutcomes(rows: FeelMatch[]): FlagOutcome[] {
  return [
    flagOutcome(rows, m => m.team_leaver, 'team_leaver', 'Team leaver'),
    flagOutcome(rows, m => m.team_thrower, 'team_thrower', 'Team thrower'),
    flagOutcome(rows, m => m.enemy_leaver, 'enemy_leaver', 'Enemy leaver'),
    flagOutcome(rows, m => m.enemy_thrower, 'enemy_thrower', 'Enemy thrower'),
  ]
}

// ---- Combined team-vs-enemy for an ordered enum (tempo / coordination).
// Returns, per enum value, the team win rate and the enemy win rate side by side.
export interface TeamEnemyRow {
  key: string
  label: string
  teamWinRate: number | null
  enemyWinRate: number | null
  teamGames: number
  enemyGames: number
  lowConfidence: boolean   // true if EITHER side is thin
}
export function teamVsEnemyByEnum<T extends string>(
  rows: FeelMatch[],
  teamField: (m: FeelMatch) => T | null,
  enemyField: (m: FeelMatch) => T | null,
  order: T[],
): TeamEnemyRow[] {
  const team = winRateByEnum(rows, teamField, order)
  const enemy = winRateByEnum(rows, enemyField, order)
  return order.map((o, i) => ({
    key: o, label: LABELS[o] ?? o,
    teamWinRate: team[i].winRate, enemyWinRate: enemy[i].winRate,
    teamGames: team[i].games, enemyGames: enemy[i].games,
    lowConfidence: team[i].games < MIN_GAMES || enemy[i].games < MIN_GAMES,
  }))
}

// ============================================================
// FEEL VS REALITY (hero-grain) — does my performance_feel match my actual,
// ROLE-AWARE, SHARE-BASED stats? Joins match feel ↔ hero stats by match_id.
// ------------------------------------------------------------
// Raw E/A/D is misleading (context-free), so we use share %s (relative to the
// lobby) and role-specific stats:
//   DPS     → damage share %   (+ final blows, solo kills)
//   Support → healing share %  (+ players saved)
//   Tank    → mitigation share % (+ obj contest time)
// Each hero row carries its match's performance_feel (joined in by the caller).
// Games-weighted: one hero row per (hero, match); we average the per-row shares
// within each performance_feel bucket.
// ============================================================

export type Role = 'tank' | 'dps' | 'support'

// A hero-grain row already joined to its match's performance_feel + role.
export interface FeelStatRow {
  match_id: number
  performance_feel: PerformanceFeel | null
  role: Role | null
  damage_pct: number | null
  healing_pct: number | null
  mitigation_pct: number | null
}

export interface FeelStatBucket {
  feel: PerformanceFeel
  role: Role
  n: number               // hero rows in this (feel, role) bucket
  avgShare: number | null // the role-appropriate share %
  shareLabel: string
  lowConfidence: boolean
}

const ROLE_SHARE: Record<Role, { field: keyof Pick<FeelStatRow, 'damage_pct' | 'healing_pct' | 'mitigation_pct'>; label: string }> = {
  dps: { field: 'damage_pct', label: 'Damage share %' },
  support: { field: 'healing_pct', label: 'Healing share %' },
  tank: { field: 'mitigation_pct', label: 'Mitigation share %' },
}

// For each (performance_feel × role), the average role-appropriate share.
// "Do games I FELT I carried actually show a higher damage share than games I
// felt I struggled?" — read down a role's column across the three feels.
export function feelVsStats(rows: FeelStatRow[]): FeelStatBucket[] {
  const out: FeelStatBucket[] = []
  for (const role of ['tank', 'dps', 'support'] as Role[]) {
    const share = ROLE_SHARE[role]
    for (const feel of PERF_FEEL_ORDER) {
      const subset = rows.filter(r => r.role === role && r.performance_feel === feel)
      const vals = subset.map(r => r[share.field])
      out.push({
        feel, role, n: subset.length,
        avgShare: mean(vals), shareLabel: share.label,
        lowConfidence: subset.length < MIN_GAMES,
      })
    }
  }
  return out
}
