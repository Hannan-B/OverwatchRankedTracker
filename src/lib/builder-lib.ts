// ============================================================
// BUILDER LIB — registry + aggregation for the generic builder
// ------------------------------------------------------------
// Pure logic, no React. Kept separate so the aggregation can be reasoned about
// and tested in isolation. The page imports from here.
//
// TWO GRAINS, never silently mixed:
//   • 'match'  → one row per match (the `matches` table).
//   • 'hero'   → one row per hero-performance (`hero_match_facts`); multiple
//                rows per match. Counting matches here would double-count, so
//                rate/count measures on hero grain are GAMES-WEIGHTED by the
//                distinct match_id within each bucket, not raw row counts.
//
// "Every variable, valid pairings only": a chart uses exactly one grain. The X
// variable's grain decides the read; a measure that needs a column from the
// other grain is disabled with a reason.
// ============================================================

export type Grain = 'match' | 'hero'
export type VarKind = 'cat' | 'num'

// Readiness mirrors §6 of the plan. Drives a small badge; THIN/STARVED still
// work, they're just sparsely populated on current data.
export type Readiness = 'ready' | 'thin' | 'starved'

export interface VarDef {
  key: string
  label: string
  column: string
  grain: Grain
  kinds: VarKind[]
  ready: Readiness
  order?: string[]      // fixed categorical ordering
  derived?: DerivedKind // computed, not a raw column
  group: string         // picker optgroup
  format?: ValueFormat  // how numeric values display (default plain number)
  lowerIsBetter?: boolean // for direction-aware cell highlighting (deaths etc.)
}

// How a numeric value should render on axes / tooltips.
export type ValueFormat = 'number' | 'percent' | 'duration'

// Derived categorical/numeric variables computed from a base column.
export type DerivedKind =
  | 'day_of_week'
  | 'time_block'
  | 'hour_of_day'
  | 'month'
  | 'session'
  | 'streak_state'
  | 'damage_share'
  | 'feel_vs_reality'

// ---- The full §7 inventory ---------------------------------------------
const RESULT_ORDER = ['victory', 'draw', 'defeat']
const DOW_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const TIME_BLOCK_ORDER = [
  'Late night (00–05)', 'Early morning (05–09)', 'Morning (09–12)',
  'Afternoon (12–17)', 'Evening (17–21)', 'Night (21–24)',
]
const HOUR_ORDER = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`)
const TEMPO_ORDER = ['aggressive', 'balanced', 'passive']
const COORD_ORDER = ['coordinated', 'average', 'chaotic']
const TILT_ORDER = ['tilted', 'annoyed', 'fine', 'good', 'hyped']
const FEEL_ORDER = ['stomped_them', 'close_game', 'got_stomped']
const PERF_ORDER = ['smurfing', 'did_my_job', 'fed', 'threw']

export const VARIABLES: VarDef[] = [
  // ---- Outcome / context (match grain) ----
  { key: 'result', label: 'Result', column: 'result', grain: 'match', kinds: ['cat'], ready: 'ready', order: RESULT_ORDER, group: 'Outcome & context' },
  { key: 'map', label: 'Map', column: 'map', grain: 'match', kinds: ['cat'], ready: 'ready', group: 'Outcome & context' },
  { key: 'game_mode', label: 'Game mode', column: 'game_mode', grain: 'match', kinds: ['cat'], ready: 'ready', group: 'Outcome & context' },
  { key: 'role_played', label: 'Role', column: 'role_played', grain: 'match', kinds: ['cat'], ready: 'ready', order: ['tank', 'dps', 'support'], group: 'Outcome & context' },
  { key: 'match_format', label: 'Format', column: 'match_format', grain: 'match', kinds: ['cat'], ready: 'ready', order: ['5v5', '6v6'], group: 'Outcome & context' },
  { key: 'starting_side', label: 'Starting side', column: 'starting_side', grain: 'match', kinds: ['cat'], ready: 'thin', order: ['attack', 'defense'], group: 'Outcome & context' },
  { key: 'game_length_seconds', label: 'Game length', column: 'game_length_seconds', grain: 'match', kinds: ['num'], ready: 'ready', group: 'Outcome & context', format: 'duration' },

  // ---- Feel (match grain) ----
  { key: 'match_feel', label: 'Match feel', column: 'match_feel', grain: 'match', kinds: ['cat'], ready: 'ready', order: FEEL_ORDER, group: 'Feel' },
  { key: 'performance_feel', label: 'Performance feel', column: 'performance_feel', grain: 'match', kinds: ['cat'], ready: 'ready', order: PERF_ORDER, group: 'Feel' },
  { key: 'fun_rating', label: 'Fun rating', column: 'fun_rating', grain: 'match', kinds: ['cat', 'num'], ready: 'ready', order: ['1', '2', '3', '4', '5'], group: 'Feel' },
  { key: 'tilt_mood', label: 'Tilt / mood', column: 'tilt_mood', grain: 'match', kinds: ['cat'], ready: 'thin', order: TILT_ORDER, group: 'Feel' },
  { key: 'team_tempo', label: 'Team tempo', column: 'team_tempo', grain: 'match', kinds: ['cat'], ready: 'thin', order: TEMPO_ORDER, group: 'Feel' },
  { key: 'team_coordination', label: 'Team coordination', column: 'team_coordination', grain: 'match', kinds: ['cat'], ready: 'thin', order: COORD_ORDER, group: 'Feel' },
  { key: 'enemy_tempo', label: 'Enemy tempo', column: 'enemy_tempo', grain: 'match', kinds: ['cat'], ready: 'thin', order: TEMPO_ORDER, group: 'Feel' },
  { key: 'enemy_coordination', label: 'Enemy coordination', column: 'enemy_coordination', grain: 'match', kinds: ['cat'], ready: 'thin', order: COORD_ORDER, group: 'Feel' },
  { key: 'team_leaver', label: 'Team leaver', column: 'team_leaver', grain: 'match', kinds: ['cat'], ready: 'starved', order: ['true', 'false'], group: 'Feel' },
  { key: 'team_thrower', label: 'Team thrower', column: 'team_thrower', grain: 'match', kinds: ['cat'], ready: 'starved', order: ['true', 'false'], group: 'Feel' },
  { key: 'enemy_leaver', label: 'Enemy leaver', column: 'enemy_leaver', grain: 'match', kinds: ['cat'], ready: 'starved', order: ['true', 'false'], group: 'Feel' },
  { key: 'enemy_thrower', label: 'Enemy thrower', column: 'enemy_thrower', grain: 'match', kinds: ['cat'], ready: 'starved', order: ['true', 'false'], group: 'Feel' },

  // ---- Combat — yours (match grain) ----
  { key: 'total_eliminations', label: 'Eliminations', column: 'total_eliminations', grain: 'match', kinds: ['num'], ready: 'ready', group: 'Combat (yours)' },
  { key: 'total_assists', label: 'Assists', column: 'total_assists', grain: 'match', kinds: ['num'], ready: 'ready', group: 'Combat (yours)' },
  { key: 'total_deaths', label: 'Deaths', column: 'total_deaths', grain: 'match', kinds: ['num'], ready: 'ready', group: 'Combat (yours)', lowerIsBetter: true },

  // ---- Comp (match grain, array → exploded to distinct comp string) ----
  { key: 'ally_team_comp', label: 'Ally comp', column: 'ally_team_comp', grain: 'match', kinds: ['cat'], ready: 'thin', group: 'Composition' },
  { key: 'enemy_team_comp', label: 'Enemy comp', column: 'enemy_team_comp', grain: 'match', kinds: ['cat'], ready: 'thin', group: 'Composition' },

  // ---- Derived (match grain, computed from played_at / sequence) ----
  { key: 'day_of_week', label: 'Day of week', column: 'played_at', grain: 'match', kinds: ['cat'], ready: 'ready', order: DOW_ORDER, derived: 'day_of_week', group: 'Derived (time)' },
  { key: 'time_block', label: 'Time block', column: 'played_at', grain: 'match', kinds: ['cat'], ready: 'ready', order: TIME_BLOCK_ORDER, derived: 'time_block', group: 'Derived (time)' },
  { key: 'hour_of_day', label: 'Hour of day', column: 'played_at', grain: 'match', kinds: ['cat'], ready: 'ready', order: HOUR_ORDER, derived: 'hour_of_day', group: 'Derived (time)' },
  { key: 'month', label: 'Month', column: 'played_at', grain: 'match', kinds: ['cat'], ready: 'ready', derived: 'month', group: 'Derived (time)' },
  { key: 'session', label: 'Session #', column: 'played_at', grain: 'match', kinds: ['cat'], ready: 'thin', derived: 'session', group: 'Derived (time)' },
  { key: 'streak_state', label: 'Streak state', column: 'result', grain: 'match', kinds: ['cat'], ready: 'thin', order: ['on a win streak', 'on a loss streak', 'neither'], derived: 'streak_state', group: 'Derived (time)' },

  // ---- Combat — hero grain (hero_match_facts) ----
  { key: 'user_damage', label: 'Hero damage', column: 'user_damage', grain: 'hero', kinds: ['num'], ready: 'thin', group: 'Combat (per hero)' },
  { key: 'user_healing', label: 'Hero healing', column: 'user_healing', grain: 'hero', kinds: ['num'], ready: 'thin', group: 'Combat (per hero)' },
  { key: 'user_mitigation', label: 'Hero mitigation', column: 'user_mitigation', grain: 'hero', kinds: ['num'], ready: 'thin', group: 'Combat (per hero)' },
  { key: 'damage_pct', label: 'Damage share %', column: 'damage_pct', grain: 'hero', kinds: ['num'], ready: 'thin', group: 'Combat (per hero)' },
  { key: 'healing_pct', label: 'Healing share %', column: 'healing_pct', grain: 'hero', kinds: ['num'], ready: 'thin', group: 'Combat (per hero)' },
  { key: 'mitigation_pct', label: 'Mitigation share %', column: 'mitigation_pct', grain: 'hero', kinds: ['num'], ready: 'thin', group: 'Combat (per hero)' },
  { key: 'user_elims_h', label: 'Elims (per hero)', column: 'user_elims', grain: 'hero', kinds: ['num'], ready: 'thin', group: 'Combat (per hero)' },
  { key: 'user_deaths_h', label: 'Deaths (per hero)', column: 'user_deaths', grain: 'hero', kinds: ['num'], ready: 'thin', group: 'Combat (per hero)', lowerIsBetter: true },

  // ---- Hero / matchup (hero grain) ----
  { key: 'hero_name', label: 'Your hero', column: 'hero_name', grain: 'hero', kinds: ['cat'], ready: 'ready', group: 'Heroes & matchups' },
  { key: 'scoreboard_hero', label: 'Enemy hero (matchup)', column: 'scoreboard_hero', grain: 'hero', kinds: ['cat'], ready: 'thin', group: 'Heroes & matchups' },
]

export const byKey = (k: string) => VARIABLES.find(v => v.key === k)
export const catVars = () => VARIABLES.filter(v => v.kinds.includes('cat'))
export const numVars = () => VARIABLES.filter(v => v.kinds.includes('num'))

// ---- Measures -----------------------------------------------------------
export type MeasureKind = 'win_rate' | 'count' | 'avg' | 'xy'
export interface MeasureDef { kind: MeasureKind; label: string; isPercent: boolean }
export const MEASURES: MeasureDef[] = [
  { kind: 'win_rate', label: 'Win rate', isPercent: true },
  { kind: 'count', label: 'Match count', isPercent: false },
  { kind: 'avg', label: 'Average of…', isPercent: false },
  { kind: 'xy', label: 'Numeric vs numeric (scatter)', isPercent: false },
]

export type ChartType = 'bar' | 'line' | 'area' | 'pie' | 'scatter' | 'radar'

// ---- Shared row shapes --------------------------------------------------
export interface MatchRow {
  id: number
  played_at: string | null
  result: 'victory' | 'defeat' | 'draw'
  map: string | null
  game_mode: string | null
  role_played: 'tank' | 'dps' | 'support'
  match_format: '5v5' | '6v6'
  starting_side: 'attack' | 'defense' | null
  game_length_seconds: number | null
  match_feel: string | null
  performance_feel: string | null
  fun_rating: number | null
  tilt_mood: string | null
  team_tempo: string | null
  team_coordination: string | null
  enemy_tempo: string | null
  enemy_coordination: string | null
  team_leaver: boolean | null
  team_thrower: boolean | null
  enemy_leaver: boolean | null
  enemy_thrower: boolean | null
  total_eliminations: number | null
  total_assists: number | null
  total_deaths: number | null
  // DB columns are nullable `text` (a single string), not arrays — #6 reconcile.
  // Typed to accept BOTH a string (the live shape) and a string[] (a possible
  // future shape) so neither breaks; bucketsFor handles both. Always null today.
  ally_team_comp: string | string[] | null
  enemy_team_comp: string | string[] | null
}

export interface HeroRow {
  match_id: number
  played_at: string | null
  result: 'victory' | 'defeat' | 'draw'
  map: string | null
  game_mode: string | null
  match_format: '5v5' | '6v6'
  starting_side: 'attack' | 'defense' | null
  hero_name: string | null
  scoreboard_hero: string | null
  user_elims: number | null
  user_assists: number | null
  user_deaths: number | null
  user_damage: number | null
  user_healing: number | null
  user_mitigation: number | null
  damage_pct: number | null
  healing_pct: number | null
  mitigation_pct: number | null
}

export const MATCH_COLS =
  'id, played_at, result, map, game_mode, role_played, match_format, starting_side, ' +
  'game_length_seconds, match_feel, performance_feel, fun_rating, tilt_mood, team_tempo, ' +
  'team_coordination, enemy_tempo, enemy_coordination, team_leaver, team_thrower, ' +
  'enemy_leaver, enemy_thrower, total_eliminations, total_assists, total_deaths, ' +
  'ally_team_comp, enemy_team_comp'

// ---- Derivations --------------------------------------------------------
const SESSION_GAP_MS = 60 * 60 * 1000 // 60 min → new session

// Named hour ranges. Boundaries chosen to read naturally; each block labels
// itself with its span so the axis is self-explanatory.
function timeBlock(d: Date): string {
  const h = d.getHours()
  if (h < 5) return 'Late night (00–05)'
  if (h < 9) return 'Early morning (05–09)'
  if (h < 12) return 'Morning (09–12)'
  if (h < 17) return 'Afternoon (12–17)'
  if (h < 21) return 'Evening (17–21)'
  return 'Night (21–24)'
}
// Raw hour of day, e.g. 18 → "18:00". Every hour is its own bucket.
function hourOfDay(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:00`
}
function dayOfWeek(d: Date): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
}
// Month as a readable name with year, e.g. "May 2026". Year kept so months
// across years stay distinct and sort correctly.
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function monthLabel(d: Date): string {
  return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`
}

// Assign a session label per match, oldest→newest, new session when the gap
// from the previous match exceeds SESSION_GAP_MS. The number is zero-padded
// ("Session 01") so string-sorting yields chronological order (1 before 10).
export function sessionMap(rows: { id: number; played_at: string | null }[]): Map<number, string> {
  const dated = rows
    .filter(r => r.played_at)
    .map(r => ({ id: r.id, t: new Date(r.played_at as string).getTime() }))
    .filter(r => !Number.isNaN(r.t))
    .sort((a, b) => a.t - b.t)
  const out = new Map<number, string>()
  let session = 0
  let prev = -Infinity
  for (const r of dated) {
    if (r.t - prev > SESSION_GAP_MS) session++
    out.set(r.id, `Session ${String(session).padStart(2, '0')}`)
    prev = r.t
  }
  return out
}

// Streak state for each match: was the player on a win/loss streak going INTO
// this match (based on the immediately preceding decisive results)?
export function streakMap(rows: { id: number; played_at: string | null; result: string }[]): Map<number, string> {
  const ordered = rows
    .filter(r => r.played_at)
    .map(r => ({ ...r, t: new Date(r.played_at as string).getTime() }))
    .filter(r => !Number.isNaN(r.t))
    .sort((a, b) => a.t - b.t)
  const out = new Map<number, string>()
  let run = 0 // +ve = win streak length, -ve = loss streak length
  for (const r of ordered) {
    out.set(r.id, run >= 2 ? 'on a win streak' : run <= -2 ? 'on a loss streak' : 'neither')
    if (r.result === 'victory') run = run > 0 ? run + 1 : 1
    else if (r.result === 'defeat') run = run < 0 ? run - 1 : -1
    // draws don't change the streak
  }
  return out
}

// ---- Bucket extraction --------------------------------------------------
// Returns the categorical bucket(s) a row contributes to for variable v.
// Most variables → a single bucket. Comp variables EXPLODE: "one row per
// distinct comp" means the comp string itself is the bucket (n=1 per unique
// comp is expected and shown honestly via sample-size flagging).
export function bucketsFor(
  row: Record<string, unknown>,
  v: VarDef,
  derivedCtx?: { session?: Map<number, string>; streak?: Map<number, string> }
): string[] {
  if (v.derived) {
    const id = Number(row['id'] ?? row['match_id'])
    if (v.derived === 'session') return [derivedCtx?.session?.get(id) ?? '—']
    if (v.derived === 'streak_state') return [derivedCtx?.streak?.get(id) ?? '—']
    const iso = row[v.column] as string | null
    if (!iso) return ['—']
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ['—']
    if (v.derived === 'day_of_week') return [dayOfWeek(d)]
    if (v.derived === 'time_block') return [timeBlock(d)]
    if (v.derived === 'hour_of_day') return [hourOfDay(d)]
    if (v.derived === 'month') return [monthLabel(d)]
  }
  const raw = row[v.column]
  if (v.key === 'ally_team_comp' || v.key === 'enemy_team_comp') {
    // DB shape is `text` (a single comp string); tolerate a future array too.
    if (Array.isArray(raw)) return raw.length ? [raw.join(' · ')] : ['—']
    if (typeof raw === 'string' && raw.trim() !== '') return [raw]
    return ['—']
  }
  if (raw === null || raw === undefined || raw === '') return ['—']
  return [String(raw)]
}

export function sortBuckets(keys: string[], v: VarDef): string[] {
  if (v.order) {
    const order = v.order
    const idx = (k: string) => {
      const i = order.indexOf(k)
      return i === -1 ? Number.MAX_SAFE_INTEGER : i
    }
    return [...keys].sort((a, b) => idx(a) - idx(b) || a.localeCompare(b))
  }
  // Month labels ("May 2026") have no fixed order array — sort chronologically
  // by parsing the label, so Jun follows May and years order correctly.
  if (v.derived === 'month') {
    const key = (k: string) => {
      const [mon, yr] = k.split(' ')
      const mi = MONTH_NAMES.indexOf(mon)
      return Number(yr) * 12 + (mi === -1 ? 99 : mi)
    }
    return [...keys].sort((a, b) => key(a) - key(b) || a.localeCompare(b))
  }
  return [...keys].sort((a, b) => a.localeCompare(b))
}

// ---- Chart-type validity (valid pairings only) --------------------------
export function chartAvailability(measure: MeasureKind): Record<ChartType, string | null> {
  if (measure === 'xy') {
    return {
      scatter: null,
      bar: 'X-vs-Y uses a scatter plot.',
      line: 'X-vs-Y uses a scatter plot.',
      area: 'X-vs-Y uses a scatter plot.',
      pie: 'X-vs-Y uses a scatter plot.',
      radar: 'X-vs-Y uses a scatter plot.',
    }
  }
  const pieReason = measure === 'count' ? null : 'Pie shows a share of a total — use Match count.'
  return {
    bar: null,
    line: null,
    area: null,
    pie: pieReason,
    scatter: 'Scatter is for Numeric-vs-numeric.',
    radar: null,
  }
}

// ---- Aggregation --------------------------------------------------------
export interface AggResult {
  data: { bucket: string; [series: string]: number | string }[]
  seriesKeys: string[]
  perBucketN: Record<string, number>
  totalN: number
}

// Win rate from a group of rows (draws excluded from denominator).
function winRate(group: { result: string }[]): number {
  const wins = group.filter(g => g.result === 'victory').length
  const decisive = group.filter(g => g.result !== 'draw').length
  return decisive > 0 ? Math.round((wins / decisive) * 1000) / 10 : 0
}
function avgOf(group: Record<string, unknown>[], col: string): number {
  const vals = group
    .map(g => g[col])
    .map(n => (typeof n === 'string' ? Number(n) : n))
    .filter((n): n is number => typeof n === 'number' && !Number.isNaN(n))
  return vals.length ? Math.round((vals.reduce((a, c) => a + c, 0) / vals.length) * 10) / 10 : 0
}

// Distinct match count within a hero-grain group (games-weighting).
function distinctMatches(group: { match_id?: number; id?: number }[]): number {
  return new Set(group.map(g => g.match_id ?? g.id)).size
}

export interface AggParams {
  rows: Record<string, unknown>[]
  xVar: VarDef
  measure: MeasureKind
  avgCol?: string
  splitByFormat: boolean
  derivedCtx?: { session?: Map<number, string>; streak?: Map<number, string> }
}

export function aggregate(p: AggParams): AggResult {
  const { rows, xVar, measure, avgCol, splitByFormat, derivedCtx } = p
  const isHero = xVar.grain === 'hero'

  const formatsPresent = Array.from(new Set(rows.map(r => String(r['match_format']))))
  const series = splitByFormat && formatsPresent.length > 1 ? formatsPresent : ['all']

  // bucket -> series -> rows
  const acc = new Map<string, Map<string, Record<string, unknown>[]>>()
  for (const r of rows) {
    const buckets = bucketsFor(r, xVar, derivedCtx)
    const s = series.length === 1 && series[0] === 'all' ? 'all' : String(r['match_format'])
    for (const b of buckets) {
      if (!acc.has(b)) acc.set(b, new Map())
      const inner = acc.get(b)!
      if (!inner.has(s)) inner.set(s, [])
      inner.get(s)!.push(r)
    }
  }

  const buckets = sortBuckets(Array.from(acc.keys()), xVar)
  const perBucketN: Record<string, number> = {}

  const data = buckets.map(b => {
    const inner = acc.get(b)!
    const datum: { bucket: string; [s: string]: number | string } = { bucket: b }
    let bucketN = 0
    for (const s of series) {
      const group = inner.get(s) || []
      // Games-weighted N for hero grain; raw rows for match grain.
      const n = isHero ? distinctMatches(group as { match_id?: number }[]) : group.length
      bucketN += n
      let val = 0
      if (measure === 'win_rate') {
        // Hero grain: weight by distinct match so a 2-hero game counts once.
        if (isHero) {
          const seen = new Map<number, string>()
          for (const g of group as { match_id: number; result: string }[]) {
            if (!seen.has(g.match_id)) seen.set(g.match_id, g.result)
          }
          val = winRate(Array.from(seen.values()).map(result => ({ result })))
        } else {
          val = winRate(group as { result: string }[])
        }
      } else if (measure === 'count') {
        val = n
      } else if (measure === 'avg' && avgCol) {
        val = avgOf(group, avgCol)
      }
      datum[s] = val
    }
    perBucketN[b] = bucketN
    return datum
  })

  const totalN = isHero
    ? distinctMatches(rows as { match_id?: number }[])
    : rows.length

  return { data, seriesKeys: series, perBucketN, totalN }
}

// Scatter: one point per row, x = numeric col, y = numeric col.
export interface ScatterPoint { x: number; y: number; label: string }
export function scatterPoints(
  rows: Record<string, unknown>[],
  xCol: string,
  yCol: string
): ScatterPoint[] {
  const num = (v: unknown) => (typeof v === 'string' ? Number(v) : (v as number))
  return rows
    .map(r => ({ x: num(r[xCol]), y: num(r[yCol]), label: String(r['map'] ?? r['hero_name'] ?? '') }))
    .filter(p => typeof p.x === 'number' && typeof p.y === 'number' && !Number.isNaN(p.x) && !Number.isNaN(p.y))
}

// ---- Value formatting ---------------------------------------------------
// Seconds → "m:ss" (e.g. 828 → "13:48"). Used for any duration-format value.
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) return '—'
  const sign = totalSeconds < 0 ? '-' : ''
  const s = Math.round(Math.abs(totalSeconds))
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${sign}${m}:${String(rem).padStart(2, '0')}`
}

// Format a numeric value for display given a ValueFormat.
export function formatValue(v: number, fmt: ValueFormat | undefined): string {
  if (fmt === 'duration') return formatDuration(v)
  if (fmt === 'percent') return `${v}%`
  return String(v)
}

// ---- Hero-grain filter --------------------------------------------------
// hero_match_facts has no role_played column (role is a match-level concept),
// so the shared matchesFilters() can't be used directly. This applies the
// format/mode/map parts; Queue's role component is intentionally a no-op here,
// and the 6v6 part is honoured via match_format. Hero narrowing is applied
// separately at the page via heroMatches(hero_name).
export interface HeroFilterable {
  match_format: '5v5' | '6v6'
  game_mode: string | null
  map: string | null
}
export function heroRowPasses(
  row: HeroFilterable,
  f: { queue: string; mode: string; map: string }
): boolean {
  if (f.queue === '6v6' && row.match_format !== '6v6') return false
  // a specific 5v5 role can't be enforced on hero grain (no role column) — the
  // hero picker scopes by role instead; here we only ensure 5v5 when a 5v5 role
  // is chosen, so 6v6 rows don't leak into a 5v5-role view.
  if (f.queue !== 'all' && f.queue !== '6v6' && row.match_format !== '5v5') return false
  if (f.mode !== 'all' && row.game_mode !== f.mode) return false
  if (f.map !== '' && row.map !== f.map) return false
  return true
}

// ============================================================
// FREE BUILDER (dual-axis) — X variable × Y variable × cell measure
// ------------------------------------------------------------
// A SECOND builder where BOTH axes are variables from VARIABLES (not a fixed
// measure list). Distinct from the generic builder above, which keeps the X as
// a variable and the Y as a measure. Everything here is additive — none of the
// exports above change.
//
// CELL MODEL (the core design):
//   • cat × cat  → a cross-tab grid. Each (X,Y) cell aggregates the games at
//                  that intersection; you pick the CELL MEASURE (win rate /
//                  count / avg of a 3rd numeric stat). Rendered as a heatmap
//                  (primary) or grouped bars.
//   • cat × num  → the numeric axis is averaged within each category bucket
//                  (handled by the existing aggregate() with measure='avg').
//   • num × num  → scatter, one point per game (existing scatterPoints()).
//
// HARD RULES (same as the generic builder):
//   • SAME GRAIN ONLY. A match-grain × hero-grain pair is INVALID (disabled
//     with a reason) — the two grains describe different-sized populations and
//     a blended cell would be ambiguous (handover §9.3A lesson 31).
//   • Hero grain is GAMES-WEIGHTED by distinct match_id (no double-counting).
//   • Percentages are never summed like counts; win rate excludes draws.
// ============================================================

// The measure that fills a cell when both axes are free variables.
export type CellMeasure = 'win_rate' | 'count' | 'avg'
export interface CellMeasureDef { kind: CellMeasure; label: string; isPercent: boolean }
export const CELL_MEASURES: CellMeasureDef[] = [
  { kind: 'win_rate', label: 'Win rate', isPercent: true },
  { kind: 'count', label: 'Game count', isPercent: false },
  { kind: 'avg', label: 'Average of…', isPercent: false },
]

// How a free X×Y pairing renders.
export type PairShape = 'crosstab' | 'cat_num' | 'scatter' | 'single'
export type FreeChartType = 'heatmap' | 'bars' | 'line' | 'area' | 'radar' | 'scatter'

// Exported aggregation primitives (the generic builder uses module-private
// copies; the Free Builder needs them too, so expose thin wrappers).
export function winRateOf(group: { result: string }[]): number {
  const wins = group.filter(g => g.result === 'victory').length
  const decisive = group.filter(g => g.result !== 'draw').length
  return decisive > 0 ? Math.round((wins / decisive) * 1000) / 10 : 0
}
export function averageOf(group: Record<string, unknown>[], col: string): number {
  const vals = group
    .map(g => g[col])
    .map(n => (typeof n === 'string' ? Number(n) : n))
    .filter((n): n is number => typeof n === 'number' && !Number.isNaN(n))
  return vals.length ? Math.round((vals.reduce((a, c) => a + c, 0) / vals.length) * 10) / 10 : 0
}
export function distinctMatchCount(group: { match_id?: number; id?: number }[]): number {
  return new Set(group.map(g => g.match_id ?? g.id)).size
}

// ---- Pair validity ------------------------------------------------------
// Decides whether an (xVar, yVar) pairing is buildable, what shape it takes,
// and which cell measures are valid. An invalid pairing carries a reason that
// the page shows (never silently hidden).
export interface PairValidity {
  ok: boolean
  reason: string | null
  shape: PairShape | null
  // For cat×cat: which cell measures apply. For cat×num / num×num: fixed.
  cellMeasures: CellMeasure[]
}

export function pairValidity(x: VarDef, y: VarDef | null): PairValidity {
  // Single-category: Y is "None". A categorical X buckets the games; the
  // measure (win rate / count / avg) is computed per bucket. This is the
  // "measure by ONE variable" case (e.g. win rate by Map).
  if (y === null) {
    if (x.kinds.includes('cat')) {
      return { ok: true, reason: null, shape: 'single', cellMeasures: ['win_rate', 'count', 'avg'] }
    }
    return {
      ok: false,
      shape: null,
      cellMeasures: [],
      reason: `${x.label} is numeric — pick a categorical X (like Map or Hero) to chart a measure by one variable, or choose a Y variable.`,
    }
  }

  // Same-grain rule — the one combination that produces ambiguous cells.
  if (x.grain !== y.grain) {
    return {
      ok: false,
      shape: null,
      cellMeasures: [],
      reason:
        `${x.label} is per-${x.grain === 'hero' ? 'hero' : 'match'} data and ` +
        `${y.label} is per-${y.grain === 'hero' ? 'hero' : 'match'} data. ` +
        `These two grains can't be combined on one chart (a cell would mix ` +
        `different-sized populations). Pick two variables of the same kind.`,
    }
  }

  const xCat = x.kinds.includes('cat')
  const yCat = y.kinds.includes('cat')
  const xNum = x.kinds.includes('num')
  const yNum = y.kinds.includes('num')

  // num × num → scatter (X numeric, Y numeric).
  if (xNum && yNum && !xCat && !yCat) {
    return { ok: true, reason: null, shape: 'scatter', cellMeasures: [] }
  }
  // A variable that is BOTH cat & num (e.g. fun_rating): treat the pairing by
  // the OTHER axis. cat×(cat|num): if the Y is numeric-only → average it.
  // cat × num → average the numeric within each category bucket.
  if (xCat && yNum && !yCat) {
    return { ok: true, reason: null, shape: 'cat_num', cellMeasures: ['avg'] }
  }
  if (xNum && yCat && !xCat) {
    // Numeric X, categorical Y — flip so the category is the grouping axis.
    return { ok: true, reason: null, shape: 'cat_num', cellMeasures: ['avg'] }
  }
  // cat × cat → cross-tab. All three cell measures are available (avg needs a
  // 3rd stat chosen on the page).
  if (xCat && yCat) {
    return { ok: true, reason: null, shape: 'crosstab', cellMeasures: ['win_rate', 'count', 'avg'] }
  }

  return {
    ok: false,
    shape: null,
    cellMeasures: [],
    reason: 'This pairing has no valid chart. Try a categorical × categorical or numeric × numeric pair.',
  }
}

// Which Free chart types are valid for a shape (invalid disabled w/ reason).
// cat×cat and cat×number both allow bar/line/area/radar; cat×cat keeps the
// heatmap as primary. num×num is scatter-only. line/area are allowed on
// unordered categoricals too (the user reads them sensibly) — not blocked.
export function freeChartAvailability(shape: PairShape | null): Record<FreeChartType, string | null> {
  const scatterOnly = 'Scatter is for numeric × numeric.'
  const heatmapNeedsTwoCat = 'A heatmap needs two categorical axes.'
  const numNumOnly = 'Numeric × numeric uses a scatter plot.'
  if (shape === 'scatter') {
    return { scatter: null, heatmap: numNumOnly, bars: numNumOnly, line: numNumOnly, area: numNumOnly, radar: numNumOnly }
  }
  if (shape === 'cat_num') {
    return { bars: null, line: null, area: null, radar: null, heatmap: heatmapNeedsTwoCat, scatter: scatterOnly }
  }
  if (shape === 'single') {
    return { bars: null, line: null, area: null, radar: null, heatmap: heatmapNeedsTwoCat, scatter: scatterOnly }
  }
  if (shape === 'crosstab') {
    return { heatmap: null, bars: null, line: null, area: null, radar: null, scatter: scatterOnly }
  }
  const pick = 'Pick a valid pairing first.'
  return { heatmap: pick, bars: pick, line: pick, area: pick, radar: pick, scatter: pick }
}

// ---- Cross-tab aggregation (cat × cat) ----------------------------------
// Builds a grid: xBuckets × yBuckets, each cell carrying the chosen measure's
// value, the games behind it (games-weighted on hero grain), and whether it's
// a thin (<5) sample. Direction-aware "best" is computed per the cell measure
// and (for avg) the chosen stat's lowerIsBetter flag.
export interface CrossCell {
  x: string
  y: string
  value: number | null   // null when no games at this intersection
  n: number              // games behind the cell
}
export interface CrossTabResult {
  xBuckets: string[]
  yBuckets: string[]
  cells: CrossCell[]                       // length = xBuckets × yBuckets
  cellAt: (x: string, y: string) => CrossCell | undefined
  min: number            // min non-null value (for color scaling)
  max: number            // max non-null value
  isPercent: boolean
  lowerIsBetter: boolean
  totalN: number
}

export interface CrossTabParams {
  rows: Record<string, unknown>[]
  xVar: VarDef
  yVar: VarDef
  cellMeasure: CellMeasure
  avgVar?: VarDef        // required when cellMeasure === 'avg'
  derivedCtx?: { session?: Map<number, string>; streak?: Map<number, string> }
}

export function crossTab(p: CrossTabParams): CrossTabResult {
  const { rows, xVar, yVar, cellMeasure, avgVar, derivedCtx } = p
  const isHero = xVar.grain === 'hero' // same as yVar.grain (validated)

  // bucketKey -> rows, keyed "x\u0000y"
  const acc = new Map<string, Record<string, unknown>[]>()
  const xSet = new Set<string>()
  const ySet = new Set<string>()
  const SEP = '\u0000'

  for (const r of rows) {
    const xs = bucketsFor(r, xVar, derivedCtx)
    const ys = bucketsFor(r, yVar, derivedCtx)
    for (const xb of xs) {
      xSet.add(xb)
      for (const yb of ys) {
        ySet.add(yb)
        const k = xb + SEP + yb
        if (!acc.has(k)) acc.set(k, [])
        acc.get(k)!.push(r)
      }
    }
  }

  const xBuckets = sortBuckets(Array.from(xSet), xVar)
  const yBuckets = sortBuckets(Array.from(ySet), yVar)

  const cells: CrossCell[] = []
  const cellMap = new Map<string, CrossCell>()
  let min = Infinity
  let max = -Infinity

  for (const xb of xBuckets) {
    for (const yb of yBuckets) {
      const group = acc.get(xb + SEP + yb) || []
      const n = isHero ? distinctMatchCount(group as { match_id?: number }[]) : group.length
      let value: number | null = null
      if (n > 0) {
        if (cellMeasure === 'count') {
          value = n
        } else if (cellMeasure === 'win_rate') {
          if (isHero) {
            const seen = new Map<number, string>()
            for (const g of group as { match_id: number; result: string }[]) {
              if (!seen.has(g.match_id)) seen.set(g.match_id, g.result)
            }
            value = winRateOf(Array.from(seen.values()).map(result => ({ result })))
          } else {
            value = winRateOf(group as { result: string }[])
          }
        } else if (cellMeasure === 'avg' && avgVar) {
          value = averageOf(group, avgVar.column)
        }
      }
      const cell: CrossCell = { x: xb, y: yb, value, n }
      cells.push(cell)
      cellMap.set(xb + SEP + yb, cell)
      if (value !== null) {
        if (value < min) min = value
        if (value > max) max = value
      }
    }
  }

  const isPercent = cellMeasure === 'win_rate'
  const lowerIsBetter =
    cellMeasure === 'avg' ? !!avgVar?.lowerIsBetter : false // count/win-rate: higher better
  const totalN = isHero
    ? distinctMatchCount(rows as { match_id?: number }[])
    : rows.length

  return {
    xBuckets,
    yBuckets,
    cells,
    cellAt: (x, y) => cellMap.get(x + SEP + y),
    min: min === Infinity ? 0 : min,
    max: max === -Infinity ? 0 : max,
    isPercent,
    lowerIsBetter,
    totalN,
  }
}

// Normalise a cell value to 0..1 for color scaling, honouring direction so the
// "good" end is always the strong colour. Returns null for empty cells.
export function cellIntensity(
  value: number | null, min: number, max: number, lowerIsBetter: boolean
): number | null {
  if (value === null) return null
  if (max === min) return 0.5
  const t = (value - min) / (max - min)
  return lowerIsBetter ? 1 - t : t
}

// ============================================================
// WIN-RATE FILTER (Free Builder, cat×cat) — the "find a nugget" filter
// ------------------------------------------------------------
// Applies ONLY to a win-rate cross-tab. Two modes:
//   • threshold   → keep cells whose win rate passes a fixed ≥ / ≤ value.
//   • vs_baseline → keep cells above (or below) the player's OVERALL win rate
//                   across the games currently in view. The baseline moves with
//                   the 4 shared filters and is GAMES-WEIGHTED (pooled), not the
//                   mean of cell values — so a 1-game 100% cell can't drag it.
// A non-passing cell isn't deleted; it's marked so the page can either hide it
// or dim it (the user's hide/highlight toggle).
// ============================================================

export type WinFilterMode = 'off' | 'threshold' | 'vs_baseline'
export type WinFilterDir = 'above' | 'below'
export interface WinFilter {
  mode: WinFilterMode
  dir: WinFilterDir       // threshold: above = ≥, below = ≤. baseline: above/below baseline.
  value: number           // only used in threshold mode (0..100)
}
export const DEFAULT_WIN_FILTER: WinFilter = { mode: 'off', dir: 'above', value: 50 }

// Pooled, games-weighted overall win rate across the rows in view. Match grain:
// one row per game. Hero grain: dedupe to distinct match_id first so a multi-
// hero game counts once. Draws excluded from the denominator (matches winRateOf).
export function baselineWinRate(rows: Record<string, unknown>[], grain: Grain): number {
  let results: { result: string }[]
  if (grain === 'hero') {
    const seen = new Map<number, string>()
    for (const r of rows as { match_id?: number; id?: number; result?: string }[]) {
      const id = (r.match_id ?? r.id) as number
      if (id != null && !seen.has(id)) seen.set(id, String(r.result))
    }
    results = Array.from(seen.values()).map(result => ({ result }))
  } else {
    results = (rows as { result?: string }[]).map(r => ({ result: String(r.result) }))
  }
  return winRateOf(results)
}

// Does a cell value pass the filter? null cells (no games) never pass.
export function cellPassesWinFilter(
  value: number | null, filter: WinFilter, baseline: number
): boolean {
  if (filter.mode === 'off') return true
  if (value === null) return false
  if (filter.mode === 'threshold') {
    return filter.dir === 'above' ? value >= filter.value : value <= filter.value
  }
  // vs_baseline
  return filter.dir === 'above' ? value > baseline : value < baseline
}
