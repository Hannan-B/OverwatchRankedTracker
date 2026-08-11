// ============================================================
// FEEL LIB — aggregations for the qualitative ("how did it feel?") fields.
// ------------------------------------------------------------
// Pure logic, no React (testable in isolation, mirrors outcomes/matchups style).
//
// ⚠️ TWO QUESTION SCALES LIVE HERE, AND THEY ARE NEVER POOLED.
//
//   Version 1 (Season 3 and earlier, FROZEN — no longer written):
//     fun_rating (1-5) · match_feel · performance_feel · tilt_mood
//     team_tempo / enemy_tempo · team_coordination / enemy_coordination
//
//   Version 2 (v1.1.0 onward):
//     fun_rating_6 (1-6, no midpoint) · matchup_feel (1-5) ·
//     performance_rating (1-5). Tilt, tempo and coordination are RETIRED.
//
// The two sets measure different things with different resolutions. A version-1
// fun_rating of 5 ("best") and a version-2 fun_rating_6 of 5 ("Great", one
// below best) are not the same answer, so averaging or charting them together
// produces a number that means nothing. Which scale a match was played under is
// decided by ITS SEASON — seasons.question_scale_version — never by a hardcoded
// season number, because the questions are expected to keep changing.
//
// Callers select ONE version and aggregate within it. See scaleVersionOf() and
// partitionByScaleVersion() at the bottom.
//
// Conventions (shared with the rest of the app):
//   • Win rate = wins / (wins + losses); DRAWS EXCLUDED from the %, counted in N.
//   • Ordered enums keep their natural order (not sorted by win rate) so the
//     scale reads left→right; unordered cuts can sort by win rate.
//   • Nothing dropped for sparsity; callers dim < minGames (default MIN_GAMES) as a confidence cue.
// The role-aware "feel vs reality" stat cross is hero-grain and lives separately
// (see feelVsStats) because it joins match feel ↔ hero stats by match_id.
// ============================================================

export type Result = 'victory' | 'defeat' | 'draw'
export const MIN_GAMES = 5

/** Which question set a match was captured under. Sourced from the match's
 *  season, never inferred from a season NUMBER. */
export type ScaleVersion = 1 | 2

// ---- Version 1 value sets (FROZEN — kept so old seasons stay readable) ----
export type MatchFeel = 'stomped_them' | 'close_game' | 'got_stomped'
export type PerformanceFeel = 'carried' | 'did_my_job' | 'struggled'
export type TiltMood = 'tilted' | 'annoyed' | 'fine' | 'good' | 'hyped'
export type Tempo = 'aggressive' | 'balanced' | 'passive'
export type Coordination = 'coordinated' | 'average' | 'chaotic'

/** Three-state leaver detail, mirroring the `leaver_type` enum. */
export type LeaverType = 'none' | 'left' | 'returned'

// The match row this lib needs (subset of `matches`).
// BOTH scales' columns are present on every row; only one set is ever
// populated, and which one is decided by the match's season.
export interface FeelMatch {
  id: number
  /** Resolves to the season's question_scale_version. Null on a match that
   *  falls outside every defined season. */
  season_id: number | null
  result: Result | null

  // ---- version 1, frozen ----
  fun_rating: number | null
  match_feel: MatchFeel | null
  performance_feel: PerformanceFeel | null
  tilt_mood: TiltMood | null
  team_tempo: Tempo | null
  enemy_tempo: Tempo | null
  team_coordination: Coordination | null
  enemy_coordination: Coordination | null

  // ---- version 2 ----
  /** 1-5: Outclassed / Behind / Even / Ahead / Dominant. The PREDICTOR in the
   *  founding hypothesis — team strength, not result. */
  matchup_feel: number | null
  /** 1-5: Off my game / Below par / Did my job / Played well / Carried. */
  performance_rating: number | null
  /** 1-6, no midpoint. The OUTCOME in the founding hypothesis. */
  fun_rating_6: number | null

  // ---- written under both scales ----
  team_leaver: boolean | null
  team_thrower: boolean | null
  enemy_leaver: boolean | null
  enemy_thrower: boolean | null
  /** Three-state leaver detail. NULL only on a row that predates the column.
   *  The BOOLEAN above is true for BOTH 'left' and 'returned', so it cannot
   *  tell a game with no scoreboard from one with a complete but skewed
   *  scoreboard — which is the entire distinction this patch introduced. */
  team_leaver_type: LeaverType | null
  enemy_leaver_type: LeaverType | null
}

// Display order + labels for each enum (natural/ordered, not win-rate-sorted).
export const MATCH_FEEL_ORDER: MatchFeel[] = ['stomped_them', 'close_game', 'got_stomped']
export const PERF_FEEL_ORDER: PerformanceFeel[] = ['carried', 'did_my_job', 'struggled']
export const TILT_ORDER: TiltMood[] = ['tilted', 'annoyed', 'fine', 'good', 'hyped']
export const TEMPO_ORDER: Tempo[] = ['aggressive', 'balanced', 'passive']
export const COORD_ORDER: Coordination[] = ['coordinated', 'average', 'chaotic']

// ---- Version 2 ordered scales ----
// Numeric, so they sort naturally and need no enum. The labels below are the
// SHORT form for chart axes; the full behavioural test that was shown at
// capture time lives in upload/page.tsx and matches/new/page.tsx.
export const MATCHUP_FEEL_ORDER: number[] = [1, 2, 3, 4, 5]
export const PERF_RATING_ORDER: number[] = [1, 2, 3, 4, 5]
export const FUN6_ORDER: number[] = [1, 2, 3, 4, 5, 6]

export const MATCHUP_FEEL_LABELS: Record<string, string> = {
  1: '1 Outclassed', 2: '2 Behind', 3: '3 Even', 4: '4 Ahead', 5: '5 Dominant',
}
export const PERF_RATING_LABELS: Record<string, string> = {
  1: '1 Off my game', 2: '2 Below par', 3: '3 Did my job',
  4: '4 Played well', 5: '5 Carried',
}
export const FUN6_LABELS: Record<string, string> = {
  1: '1 Miserable', 2: '2 Bad', 3: '3 Poor',
  4: '4 Good', 5: '5 Great', 6: '6 Brilliant',
}

export const LABELS: Record<string, string> = {
  stomped_them: 'Stomped them', close_game: 'Close game', got_stomped: 'Got stomped',
  carried: 'Carried', did_my_job: 'Did my job', struggled: 'Struggled',
  tilted: 'Tilted', annoyed: 'Annoyed', fine: 'Fine', good: 'Good', hyped: 'Hyped',
  aggressive: 'Aggressive', balanced: 'Balanced', passive: 'Passive',
  coordinated: 'Coordinated', average: 'Average', chaotic: 'Chaotic',
}
// NOTE: the version-2 numeric scales deliberately do NOT live in this shared
// map. Their keys would be '1'..'6' across three different scales meaning
// three different things, so a shared map would collide. Each has its own
// label map (MATCHUP_FEEL_LABELS / PERF_RATING_LABELS / FUN6_LABELS), passed
// explicitly to the aggregator that needs it.

/**
 * The fields scaleVersionOf() actually reads.
 *
 * Declared as a SUBSET rather than requiring a full FeelMatch, so any row shape
 * carrying a season and the version-2 columns can ask which question set it
 * belongs to — the match detail page passes a plain `Match`, whose enum columns
 * are declared more loosely than FeelMatch's and which therefore isn't
 * assignable to it. The alternative was letting that page keep its own copy of
 * the "which scale is this?" decision, and that decision is the never-pool rule
 * itself; it must have exactly one implementation.
 */
export interface ScaleResolvable {
  season_id: number | null
  fun_rating_6: number | null
  matchup_feel: number | null
  performance_rating: number | null
}

/**
 * Look up a version-2 label WITHOUT its leading rank number: 4 → "Good".
 *
 * The maps above are written for CHART AXES, where the number carries the
 * ordering and a bare "Good" next to "Great" is ambiguous about direction. When
 * displaying a SINGLE match there is no axis and no ordering to convey, so the
 * number is noise — "Fun: Good" reads as English, "Fun: 4 Good" reads as a
 * database row.
 *
 * Strips a leading "<digits> " only, so a label that legitimately began with a
 * number would survive. Returns null for a null value, so callers can skip the
 * row entirely rather than print a placeholder.
 */
export function bareLabel(
  labels: Record<string, string>,
  value: number | string | null | undefined,
): string | null {
  if (value == null) return null
  const raw = labels[String(value)]
  if (!raw) return null
  return raw.replace(/^\d+\s+/, '')
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
export function distByEnum<T extends string | number>(
  rows: FeelMatch[],
  field: (m: FeelMatch) => T | null,
  order: T[],
  minGames: number = MIN_GAMES,
  labels: Record<string, string> = LABELS,
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
      key: String(o), label: labels[String(o)] ?? String(o),
      pct: total > 0 ? Math.round((count / total) * 1000) / 10 : null,
      count, total, lowConfidence: count < minGames,
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
  minGames: number = MIN_GAMES,
): TeamEnemyDistRow[] {
  const team = distByEnum(rows, teamField, order, minGames)
  const enemy = distByEnum(rows, enemyField, order, minGames)
  return order.map((o, i) => ({
    key: String(o), label: LABELS[String(o)] ?? String(o),
    teamPct: team[i].pct, enemyPct: enemy[i].pct,
    teamCount: team[i].count, enemyCount: enemy[i].count,
    lowConfidence: team[i].count < minGames || enemy[i].count < minGames,
  }))
}
export function winRateByEnum<T extends string | number>(
  rows: FeelMatch[],
  field: (m: FeelMatch) => T | null,
  order: T[],
  minGames: number = MIN_GAMES,
  labels: Record<string, string> = LABELS,
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
      key: String(o), label: labels[String(o)] ?? String(o),
      winRate: winRate(tt), games: games(tt),
      wins: tt.wins, losses: tt.losses, draws: tt.draws, lowConfidence: games(tt) < minGames,
    }
  })
}

// ---- Fun rating ----
// TWO SCALES, and the difference is not cosmetic. Version 1 is 1-5 with a
// midpoint; version 2 is 1-6 with NO midpoint, so every answer must lean. A
// version-1 "5" is the top of the scale; a version-2 "5" is one below it.
// Reading the version-appropriate column is therefore mandatory, and the
// bucket COUNT changes with it — a 6-point distribution rendered over five
// buckets would silently drop every "Brilliant".

/** The fun column and point count for a scale version. */
export function funScale(version: ScaleVersion): { max: number; get: (m: FeelMatch) => number | null } {
  return version === 2
    ? { max: 6, get: (m: FeelMatch) => m.fun_rating_6 }
    : { max: 5, get: (m: FeelMatch) => m.fun_rating }
}

// Distribution: count of games at each point (always ALL buckets for the scale).
export interface FunBucket { star: number; count: number; lowConfidence: boolean }
export function funDistribution(
  rows: FeelMatch[],
  version: ScaleVersion = 1,
  minGames: number = MIN_GAMES,
): FunBucket[] {
  const { max, get } = funScale(version)
  const counts = new Array<number>(max).fill(0)
  for (const r of rows) {
    const f = get(r)
    if (f != null && f >= 1 && f <= max) counts[f - 1]++
  }
  return counts.map((count, i) => ({ star: i + 1, count, lowConfidence: count < minGames }))
}

// Average fun by result (win / loss / draw).
export interface AvgFunRow { result: Result; avgFun: number | null; games: number; lowConfidence: boolean }
export function avgFunByResult(
  rows: FeelMatch[],
  version: ScaleVersion = 1,
  minGames: number = MIN_GAMES,
): AvgFunRow[] {
  const { get } = funScale(version)
  const order: Result[] = ['victory', 'defeat', 'draw']
  return order.map(res => {
    const subset = rows.filter(r => r.result === res && get(r) != null)
    return {
      result: res,
      avgFun: mean(subset.map(get)),
      games: subset.length,
      lowConfidence: subset.length < minGames,
    }
  })
}

// Fun distribution split by result — for a stacked/grouped view.
// Returns one row per point with a count per result.
export interface FunByResultRow { star: number; victory: number; defeat: number; draw: number; total: number }
export function funByResult(rows: FeelMatch[], version: ScaleVersion = 1): FunByResultRow[] {
  const { max, get } = funScale(version)
  const buckets: FunByResultRow[] = Array.from({ length: max }, (_, i) => ({
    star: i + 1, victory: 0, defeat: 0, draw: 0, total: 0,
  }))
  for (const r of rows) {
    const f = get(r)
    if (f == null || f < 1 || f > max) continue
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
export function flagOutcome(rows: FeelMatch[], field: (m: FeelMatch) => boolean | null, key: string, label: string, minGames: number = MIN_GAMES): FlagOutcome {
  const t = emptyTally()
  for (const r of rows) {
    if (field(r) === true) add(t, r.result)
  }
  return {
    key, label, games: games(t), wins: t.wins, losses: t.losses, draws: t.draws,
    winRate: winRate(t), lowConfidence: games(t) < minGames,
  }
}

/**
 * All flags as count+outcome rows (for the combined leaver/thrower view).
 *
 * ⚠️ SPLIT BY LEAVER TYPE UNDER VERSION 2 ONLY, and the reason is not
 * cosmetic. `team_leaver` is true for BOTH a permanent leaver and one who came
 * back, and those are structurally different games: a permanent leaver's board
 * is a row short and no scoreboard is stored at all, while a returned leaver's
 * board is complete and merely skewed. Pooling them under one "Team leaver" row
 * hides exactly the distinction this scale version exists to capture.
 *
 * Version 1 stays on the four boolean rows DELIBERATELY. Its rows were seeded
 * to 'left' wholesale because the old boolean genuinely could not tell the two
 * apart — so splitting them there would invent a precision the data never had,
 * showing every historical leaver as permanent when some were not.
 */
export function allFlagOutcomes(
  rows: FeelMatch[],
  minGames: number = MIN_GAMES,
  version: ScaleVersion = 1,
): FlagOutcome[] {
  if (version === 2) {
    return [
      flagOutcome(rows, m => m.team_leaver_type === 'left', 'team_left', 'Team leaver (gone)', minGames),
      flagOutcome(rows, m => m.team_leaver_type === 'returned', 'team_returned', 'Team leaver (returned)', minGames),
      flagOutcome(rows, m => m.team_thrower, 'team_thrower', 'Team thrower', minGames),
      flagOutcome(rows, m => m.enemy_leaver_type === 'left', 'enemy_left', 'Enemy leaver (gone)', minGames),
      flagOutcome(rows, m => m.enemy_leaver_type === 'returned', 'enemy_returned', 'Enemy leaver (returned)', minGames),
      flagOutcome(rows, m => m.enemy_thrower, 'enemy_thrower', 'Enemy thrower', minGames),
    ]
  }
  return [
    flagOutcome(rows, m => m.team_leaver, 'team_leaver', 'Team leaver', minGames),
    flagOutcome(rows, m => m.team_thrower, 'team_thrower', 'Team thrower', minGames),
    flagOutcome(rows, m => m.enemy_leaver, 'enemy_leaver', 'Enemy leaver', minGames),
    flagOutcome(rows, m => m.enemy_thrower, 'enemy_thrower', 'Enemy thrower', minGames),
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
  minGames: number = MIN_GAMES,
): TeamEnemyRow[] {
  const team = winRateByEnum(rows, teamField, order, minGames)
  const enemy = winRateByEnum(rows, enemyField, order, minGames)
  return order.map((o, i) => ({
    key: String(o), label: LABELS[String(o)] ?? String(o),
    teamWinRate: team[i].winRate, enemyWinRate: enemy[i].winRate,
    teamGames: team[i].games, enemyGames: enemy[i].games,
    lowConfidence: team[i].games < minGames || enemy[i].games < minGames,
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

// A hero-grain row already joined to its match's performance answer + role.
// `perfKey` is the version-appropriate performance value — the version-1
// enum (`carried` / `did_my_job` / `struggled`) or the version-2 rating (1-5).
// It is deliberately untyped beyond string|number: this function does not care
// which scale it is given, only that the caller passes a matching `order`. That
// keeps the never-pool rule enforceable at ONE place (the caller picks a
// version) instead of being re-litigated inside every aggregator.
export interface FeelStatRow {
  match_id: number
  perfKey: string | number | null
  role: Role | null
  damage_pct: number | null
  healing_pct: number | null
  mitigation_pct: number | null
}

export interface FeelStatBucket {
  feel: string             // String(perfKey) for the bucket
  label: string            // display label for that value
  role: Role
  n: number                // hero rows in this (feel, role) bucket
  avgShare: number | null  // the role-appropriate share %
  shareLabel: string
  lowConfidence: boolean
}

const ROLE_SHARE: Record<Role, { field: keyof Pick<FeelStatRow, 'damage_pct' | 'healing_pct' | 'mitigation_pct'>; label: string }> = {
  dps: { field: 'damage_pct', label: 'Damage share %' },
  support: { field: 'healing_pct', label: 'Healing share %' },
  tank: { field: 'mitigation_pct', label: 'Mitigation share %' },
}

// For each (performance value × role), the average role-appropriate share.
// "Do games I FELT I carried actually show a higher damage share than games I
// felt I struggled?" — read down a role's column across the values.
export function feelVsStats(
  rows: FeelStatRow[],
  order: (string | number)[] = PERF_FEEL_ORDER,
  minGames: number = MIN_GAMES,
  labels: Record<string, string> = LABELS,
): FeelStatBucket[] {
  const out: FeelStatBucket[] = []
  for (const role of ['tank', 'dps', 'support'] as Role[]) {
    const share = ROLE_SHARE[role]
    for (const value of order) {
      const subset = rows.filter(r => r.role === role && r.perfKey === value)
      const vals = subset.map(r => r[share.field])
      out.push({
        feel: String(value),
        label: labels[String(value)] ?? String(value),
        role,
        n: subset.length,
        avgShare: mean(vals), shareLabel: share.label,
        lowConfidence: subset.length < minGames,
      })
    }
  }
  return out
}

// ============================================================
// FUN CROSSES — the founding hypothesis
// ------------------------------------------------------------
// "A tight loss is more fun than a stomp win." That claim is about MATCH-UP
// against FUN, not result against fun — which is why the two result-based fun
// panels are kept alongside these as the control rather than replaced by them.
// ============================================================

/** Average fun at each value of some other answer, e.g. fun by match-up. */
export interface AvgFunByRow {
  key: string
  label: string
  avgFun: number | null
  n: number            // games with BOTH answers present
  lowConfidence: boolean
}
export function avgFunByEnum<T extends string | number>(
  rows: FeelMatch[],
  field: (m: FeelMatch) => T | null,
  order: T[],
  version: ScaleVersion = 1,
  minGames: number = MIN_GAMES,
  labels: Record<string, string> = LABELS,
): AvgFunByRow[] {
  const { get } = funScale(version)
  return order.map(o => {
    const subset = rows.filter(r => field(r) === o && get(r) != null)
    return {
      key: String(o), label: labels[String(o)] ?? String(o),
      avgFun: mean(subset.map(get)),
      n: subset.length,
      lowConfidence: subset.length < minGames,
    }
  })
}

/**
 * Fun collapsed to the enjoyed / didn't-enjoy binary, per value of another answer.
 *
 * ⚠️ VERSION 2 ONLY, and that restriction is the point rather than an
 * oversight. The 6-point scale was built with NO MIDPOINT precisely so every
 * answer has to fall on one side of the 3/4 boundary — which makes this
 * collapse exact. Version 1's 5-point scale has a middle value that means
 * neither, so the same collapse would either discard those games or assign
 * them arbitrarily. Callers must not offer this view for version 1.
 *
 * Why it exists: the full 5×6 grid is 30 cells, and at a realistic answer
 * distribution the cells that actually test the hypothesis — outclassed but
 * enjoyable, dominant but dull — are the rarest on the board and need several
 * hundred games. Collapsing fun to the binary the scale already encodes gets
 * the same question answered at roughly 150.
 */
export interface FunBinaryRow {
  key: string
  label: string
  enjoyed: number      // fun 4-6
  notEnjoyed: number   // fun 1-3
  total: number
  enjoyedPct: number | null
  lowConfidence: boolean
}
export function funBinaryByEnum<T extends string | number>(
  rows: FeelMatch[],
  field: (m: FeelMatch) => T | null,
  order: T[],
  minGames: number = MIN_GAMES,
  labels: Record<string, string> = LABELS,
): FunBinaryRow[] {
  return order.map(o => {
    let enjoyed = 0, notEnjoyed = 0
    for (const r of rows) {
      if (field(r) !== o) continue
      const f = r.fun_rating_6
      if (f == null) continue
      if (f >= 4) enjoyed++
      else notEnjoyed++
    }
    const total = enjoyed + notEnjoyed
    return {
      key: String(o), label: labels[String(o)] ?? String(o),
      enjoyed, notEnjoyed, total,
      enjoyedPct: total > 0 ? Math.round((enjoyed / total) * 1000) / 10 : null,
      lowConfidence: total < minGames,
    }
  })
}

// ============================================================
// STANDOUT HEROES
// ------------------------------------------------------------
// The heroes you flagged after a match: an ALLY who impressed you, or an ENEMY
// who gave you trouble. The two are NOT symmetric — there is no "ally who was
// bad" or "enemy who was easy" — so they are always presented as two separate
// lists and never merged into one ranking.
//
// Ranked by how often you picked them, then profiled by how those games felt.
// The ranking is noisy until the counts are substantial: at low n, "top 5"
// largely reflects which heroes you happened to meet. Callers show n on every
// tile and dim below minGames rather than hiding thin rows, so the thinness is
// visible instead of being disguised as a finding.
// ============================================================

export interface StandoutRow {
  match_id: number
  kind: 'impressed_ally' | 'struggled_enemy'
  hero_name: string | null
}

export interface StandoutProfile {
  hero: string
  picks: number              // matches where this hero was flagged
  wins: number
  losses: number
  draws: number
  winRate: number | null
  avgMatchup: number | null
  avgPerformance: number | null
  avgFun: number | null
  lowConfidence: boolean
}

/**
 * Top-N standout heroes of one kind, with the feel profile of the games they
 * appeared in.
 *
 * `matchById` must already be narrowed to the visible, single-scale rows: the
 * averages below read the version-appropriate columns, so passing a mixed set
 * would silently blend two scales inside one tile.
 */
export function standoutProfiles(
  standouts: StandoutRow[],
  matchById: Map<number, FeelMatch>,
  kind: StandoutRow['kind'],
  version: ScaleVersion = 2,
  topN: number = 5,
  minGames: number = MIN_GAMES,
): StandoutProfile[] {
  const { get: getFun } = funScale(version)
  const byHero = new Map<string, FeelMatch[]>()

  for (const s of standouts) {
    if (s.kind !== kind || !s.hero_name) continue
    // An unresolved pick (hero_name null) is deliberately skipped rather than
    // bucketed as "Unknown": the slot was recorded, but which hero occupied it
    // is genuinely not known, and a phantom hero row would be worse than a gap.
    const m = matchById.get(s.match_id)
    if (!m) continue   // outside the current filter/scale view
    const list = byHero.get(s.hero_name)
    if (list) list.push(m)
    else byHero.set(s.hero_name, [m])
  }

  const out: StandoutProfile[] = []
  for (const [hero, ms] of byHero) {
    const t = emptyTally()
    for (const m of ms) add(t, m.result)
    out.push({
      hero,
      picks: ms.length,
      wins: t.wins, losses: t.losses, draws: t.draws,
      winRate: winRate(t),
      avgMatchup: mean(ms.map(m => (version === 2 ? m.matchup_feel : null))),
      avgPerformance: mean(ms.map(m => (version === 2 ? m.performance_rating : null))),
      avgFun: mean(ms.map(getFun)),
      lowConfidence: ms.length < minGames,
    })
  }

  // Most-picked first; hero name as a stable tiebreak so the order does not
  // shuffle between renders when counts are equal (common at low n).
  out.sort((a, b) => b.picks - a.picks || a.hero.localeCompare(b.hero))
  return out.slice(0, topN)
}
// ------------------------------------------------------------
// Which question set a match was captured under is a property of its SEASON.
// A chart that hardcodes "season 3 and earlier" breaks silently the next time
// the questions change, and they are expected to keep changing — so the
// version is looked up, never assumed.
// ============================================================

/**
 * Resolve a match's scale version.
 *
 * Order of preference:
 *   1. Its season's recorded version. The authority.
 *   2. If the season is unknown (season_id null, or a season missing from the
 *      map), infer from WHICH COLUMNS ARE POPULATED. Only one set is ever
 *      written per match, so a populated version-2 column is conclusive.
 *   3. Version 1 as the final fallback — every match that predates the change
 *      is version 1, and a row with no feel answers at all renders nothing
 *      either way, so this cannot mislabel real data.
 */
export function scaleVersionOf(
  m: ScaleResolvable,
  seasonVersions: Map<number, number>,
): ScaleVersion {
  if (m.season_id != null) {
    const v = seasonVersions.get(m.season_id)
    if (v === 2) return 2
    if (v === 1) return 1
  }
  if (m.fun_rating_6 != null || m.matchup_feel != null || m.performance_rating != null) return 2
  return 1
}

/** Split rows by scale version. Callers aggregate WITHIN one bucket — this is
 *  the single point where the never-pool rule is enforced. */
export function partitionByScaleVersion<T extends FeelMatch>(
  rows: T[],
  seasonVersions: Map<number, number>,
): Record<ScaleVersion, T[]> {
  const out: Record<ScaleVersion, T[]> = { 1: [], 2: [] }
  for (const r of rows) out[scaleVersionOf(r, seasonVersions)].push(r)
  return out
}
