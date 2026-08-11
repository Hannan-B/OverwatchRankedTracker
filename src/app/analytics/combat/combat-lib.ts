// ============================================================
// COMBAT LIB — aggregations for the Combat page.
// ------------------------------------------------------------
// Pure logic, no React (testable in isolation; mirrors time-lib / feel-lib).
//
// Reads the `combat_facts` view (hero_match_facts + is_alpha). Two grains live
// in one row set, so we are careful which we use where:
//
//   • MATCH GRAIN (share metrics): damage_pct / healing_pct / mitigation_pct are
//     the USER'S WHOLE-MATCH team share, denormalised onto every hero row of the
//     match. We DEDUPE to one row per match before any share aggregation — never
//     sum across hero rows (that would multiply by the hero count).
//
//   • HERO GRAIN (role-specific counts): final_blows / solo_kills are per-hero.
//     The USER'S own hero in a match is the row where hero_name == scoreboard_hero.
//     obj_contest_time / players_saved attach to whichever hero carried them; we
//     read them from the user's hero row too.
//
// ROLE-AWARENESS: which share matters depends on the role being viewed:
//     tank → mitigation_pct, dps → damage_pct, support → healing_pct.
// The page drives role from the Queue filter; this lib takes an explicit role.
//
// DATA QUALITY: many rows have null shares (ally team not fully captured — the
// view nulls them on purpose). We NEVER fabricate; a null share is excluded from
// the metric and counted toward COVERAGE ("computed from N of M games") so the
// gap is visible rather than hidden. Same for null role-specific stats.
//
// CONVENTIONS (shared with the rest of the app):
//   • Win rate = wins / (wins + losses); draws excluded from %, counted in N.
//   • Shares are stored 0–100 already (e.g. "25.58") — parsed, NOT re-scaled.
//   • Sparse buckets are flagged lowConfidence (< minGames, default MIN_GAMES); callers dim them.
// ============================================================

export type Result = 'victory' | 'defeat' | 'draw'
export type Role = 'tank' | 'dps' | 'support'
export const MIN_GAMES = 5

// A row of combat_facts. Several numeric columns arrive as strings from the
// view (Supabase returns numeric/text columns verbatim), so everything that
// could be string|number|null is typed that way and parsed via num().
export interface CombatFactRow {
  hero_performance_id: number
  match_id: number
  hero_name: string | null
  match_format: '5v5' | '6v6'
  map: string | null
  game_mode: string | null
  starting_side: string | null
  result: Result | null
  season_id: number | null
  played_at: string | null
  percent_played: string | number | null
  is_single_hero: boolean | null
  game_length_seconds: number | null
  eff_play_time_seconds: string | number | null
  scoreboard_hero: string | null
  user_elims: string | number | null
  user_assists: string | number | null
  user_deaths: string | number | null
  user_damage: string | number | null
  user_healing: string | number | null
  user_mitigation: string | number | null
  ally_total_damage: string | number | null
  enemy_total_damage: string | number | null
  // Total deaths across the ally team's scoreboard rows (#8). Added to the
  // match_team_damage → hero_match_facts → combat_facts view chain. Optional so
  // the type stays tolerant if a stale combat_facts (pre-migration) is read.
  ally_total_deaths?: string | number | null
  damage_pct: string | number | null
  healing_pct: string | number | null
  mitigation_pct: string | number | null
  final_blows: string | number | null
  solo_kills: string | number | null
  obj_contest_time: string | number | null
  players_saved: string | number | null
  // role_played is needed to map a match to its role for the share metric.
  role_played?: Role | null
  is_alpha?: boolean | null
  // Match-grain leaver flags (from matches m, exposed by the combat_facts view).
  // Optional so the type is tolerant if the view hasn't been updated yet.
  team_leaver?: boolean | null
  enemy_leaver?: boolean | null
}

// ---- numeric parsing ----
// Parse a value that may be a number, a numeric string ("25.58", "5"), a
// percent string ("42%"), or null/garbage. Returns null when not a finite
// number. Does NOT parse durations (MM:SS) — see parseDuration for that.
export function num(v: string | number | null | undefined): number | null {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const cleaned = v.replace(/[%,]/g, '').trim()
  if (cleaned === '') return null
  // reject time-formatted values here (handled separately)
  if (/^\d{1,3}:\d{2}$/.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

// Parse a duration that may be "MM:SS", "M:SS", a plain seconds number, or a
// numeric string. Returns seconds, or null. obj_contest_time has appeared both
// as a count-like integer and, in the OCR source, as MM:SS — handle both.
export function parseDuration(v: string | number | null | undefined): number | null {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = v.trim()
  const m = s.match(/^(\d{1,3}):(\d{2})$/)
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
  return num(s)
}

export function parseTime(played_at: string | null): number | null {
  if (!played_at) return null
  const t = new Date(played_at).getTime()
  return Number.isNaN(t) ? null : t
}

// The share field for a role.
export function shareField(role: Role): keyof Pick<CombatFactRow, 'damage_pct' | 'healing_pct' | 'mitigation_pct'> {
  return role === 'tank' ? 'mitigation_pct' : role === 'dps' ? 'damage_pct' : 'healing_pct'
}
export const SHARE_LABEL: Record<Role, string> = {
  tank: 'Mitigation share %', dps: 'Damage share %', support: 'Healing share %',
}

// ---- win-rate primitives (same shape as the other libs) ----
export interface Tally { wins: number; losses: number; draws: number }
export function emptyTally(): Tally { return { wins: 0, losses: 0, draws: 0 } }
export function add(t: Tally, r: Result | null) {
  if (r === 'victory') t.wins++
  else if (r === 'defeat') t.losses++
  else if (r === 'draw') t.draws++
}
export function games(t: Tally): number { return t.wins + t.losses + t.draws }

export function mean(vals: number[]): number | null {
  return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null
}

// ============================================================
// MATCH-GRAIN DEDUPE.
// One row per match (the user's whole-match figures are identical across that
// match's hero rows). We pick the user's hero row when identifiable
// (hero_name == scoreboard_hero), else the first row — the share columns are the
// same either way, but picking the user's row also gives the correct per-hero
// final_blows/solo_kills for the DPS stat at the same time.
// ============================================================
export interface MatchRow {
  match_id: number
  result: Result | null
  played_at: string | null
  role: Role | null
  share: number | null          // role-appropriate share (set by caller per role)
  // raw shares kept so the page can show all three for 6v6 / all-queues:
  damagePct: number | null
  healingPct: number | null
  mitigationPct: number | null
}

// Reduce fact rows to one MatchRow per match. `role` is resolved from
// role_played when present (5v5), else left null (6v6 multi-role).
export function dedupeMatches(rows: CombatFactRow[]): MatchRow[] {
  const byMatch = new Map<number, CombatFactRow[]>()
  for (const r of rows) {
    if (!byMatch.has(r.match_id)) byMatch.set(r.match_id, [])
    byMatch.get(r.match_id)!.push(r)
  }
  const out: MatchRow[] = []
  for (const [match_id, group] of byMatch.entries()) {
    // prefer the user's own hero row (hero_name == scoreboard_hero)
    const userRow = group.find(g => g.scoreboard_hero != null && g.hero_name === g.scoreboard_hero) ?? group[0]
    const role = (userRow.role_played ?? null) as Role | null
    const damagePct = num(userRow.damage_pct)
    const healingPct = num(userRow.healing_pct)
    const mitigationPct = num(userRow.mitigation_pct)
    out.push({
      match_id,
      result: userRow.result,
      played_at: userRow.played_at,
      role,
      share: null, // filled per-role by the caller
      damagePct, healingPct, mitigationPct,
    })
  }
  // chronological
  return out.sort((a, b) => (parseTime(a.played_at) ?? 0) - (parseTime(b.played_at) ?? 0))
}

// Attach the role-appropriate share to each match row, for a given role.
export function withShareForRole(matches: MatchRow[], role: Role): MatchRow[] {
  return matches.map(m => ({
    ...m,
    share: role === 'tank' ? m.mitigationPct : role === 'dps' ? m.damagePct : m.healingPct,
  }))
}

// ============================================================
// COVERAGE — how many matches actually have the metric vs total in view.
// ============================================================
export interface Coverage { withData: number; total: number }
export function coverage(matches: MatchRow[]): Coverage {
  return { withData: matches.filter(m => m.share != null).length, total: matches.length }
}

// ============================================================
// SHARE IN WINS vs LOSSES.
//   averages: avg share in wins, in losses (draws excluded from the split).
//   spread:   per-game share points tagged win/loss, for a scatter/strip plot.
// Only matches with a non-null share contribute.
// ============================================================
export interface WinLossShare {
  wins: { avg: number | null; n: number }
  losses: { avg: number | null; n: number }
  spread: { result: Result; share: number; match_id: number }[]
}
export function shareWinsVsLosses(matches: MatchRow[]): WinLossShare {
  const winVals: number[] = []
  const lossVals: number[] = []
  const spread: { result: Result; share: number; match_id: number }[] = []
  for (const m of matches) {
    if (m.share == null || m.result == null) continue
    if (m.result === 'victory') winVals.push(m.share)
    else if (m.result === 'defeat') lossVals.push(m.share)
    if (m.result !== 'draw') spread.push({ result: m.result, share: m.share, match_id: m.match_id })
  }
  return {
    wins: { avg: mean(winVals), n: winVals.length },
    losses: { avg: mean(lossVals), n: lossVals.length },
    spread,
  }
}

// ============================================================
// SHARE TREND OVER TIME.
//   perMatch: one point per match with a share, in chronological order.
//   byWeek:   ISO-week buckets (avg share + game count) — reuses the same week
//             keying idea as the Time page for consistency.
// ============================================================
export interface TrendPoint { match_id: number; t: number; share: number; result: Result | null }
export function shareTrendPerMatch(matches: MatchRow[]): TrendPoint[] {
  const pts: TrendPoint[] = []
  for (const m of matches) {
    const t = parseTime(m.played_at)
    if (m.share == null || t == null) continue
    pts.push({ match_id: m.match_id, t, share: m.share, result: m.result })
  }
  return pts.sort((a, b) => a.t - b.t)
}

// ISO week key (Mon-started), local time. Mirrors time-lib's isoWeek label form.
export interface WeekShare { key: string; label: string; avgShare: number | null; games: number; lowConfidence: boolean }
function isoWeekLabel(d: Date): { key: string; label: string } {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dowMon0 = (date.getDay() + 6) % 7
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - dowMon0)
  const day = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - day + 3)
  const firstThursday = new Date(date.getFullYear(), 0, 4)
  const firstDay = (firstThursday.getDay() + 6) % 7
  firstThursday.setDate(firstThursday.getDate() - firstDay + 3)
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000))
  const year = date.getFullYear()
  const dd = String(monday.getDate()).padStart(2, '0')
  const mm = String(monday.getMonth() + 1).padStart(2, '0')
  return { key: `${year}-W${String(week).padStart(2, '0')}`, label: `W${week} · ${dd}/${mm}` }
}
export function shareTrendByWeek(matches: MatchRow[], minGames: number = MIN_GAMES): WeekShare[] {
  const byWeek = new Map<string, { label: string; vals: number[] }>()
  for (const m of matches) {
    const t = parseTime(m.played_at)
    if (m.share == null || t == null) continue
    const wk = isoWeekLabel(new Date(t))
    if (!byWeek.has(wk.key)) byWeek.set(wk.key, { label: wk.label, vals: [] })
    byWeek.get(wk.key)!.vals.push(m.share)
  }
  return Array.from(byWeek.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, v]) => ({
      key, label: v.label,
      avgShare: mean(v.vals), games: v.vals.length,
      lowConfidence: v.vals.length < minGames,
    }))
}

// ============================================================
// ALL-QUEUES PER-ROLE SUMMARY.
// When no single role is selected (queue = all), a combined share number is
// meaningless (mitigation% and damage% aren't comparable), so we summarise each
// role separately: avg of the role-appropriate share across matches the user
// played that role, with coverage.
// ============================================================
export interface RoleShareSummary {
  role: Role
  label: string
  avgShare: number | null
  withData: number
  total: number
  lowConfidence: boolean
}
export function perRoleSummary(matches: MatchRow[], minGames: number = MIN_GAMES): RoleShareSummary[] {
  const roles: Role[] = ['tank', 'dps', 'support']
  return roles.map(role => {
    const ofRole = matches.filter(m => m.role === role)
    const vals = ofRole
      .map(m => role === 'tank' ? m.mitigationPct : role === 'dps' ? m.damagePct : m.healingPct)
      .filter((v): v is number => v != null)
    return {
      role, label: SHARE_LABEL[role],
      avgShare: mean(vals),
      withData: vals.length, total: ofRole.length,
      lowConfidence: vals.length < minGames,
    }
  })
}

// ============================================================
// 6v6 SUMMARY — role-AGNOSTIC. In 6v6 the user plays multiple roles within one
// match, so bucketing each match into a single role (as perRoleSummary does for
// 5v5) is wrong: a 6v6 game contributes a real damage share AND healing share
// AND mitigation share. So we average each of the three shares across ALL the
// (6v6) matches in view, independent of role_played — which also makes 6v6 work
// whether or not role_played is populated for those games. Each stat reports its
// own coverage (non-null share count).
// ============================================================
export function sixVsSixSummary(matches: MatchRow[], minGames: number = MIN_GAMES): RoleShareSummary[] {
  const specs: { role: Role; pick: (m: MatchRow) => number | null }[] = [
    { role: 'tank', pick: m => m.mitigationPct },
    { role: 'dps', pick: m => m.damagePct },
    { role: 'support', pick: m => m.healingPct },
  ]
  return specs.map(({ role, pick }) => {
    const vals = matches.map(pick).filter((v): v is number => v != null)
    return {
      role, label: SHARE_LABEL[role],
      avgShare: mean(vals),
      withData: vals.length, total: matches.length,
      lowConfidence: vals.length < minGames,
    }
  })
}

// ============================================================
// ROLE-SPECIFIC STATS (hero grain, user's own hero row).
// We work directly off the fact rows (not the deduped match rows) so we can read
// the user's hero row per match. The user's hero row is hero_name==scoreboard_hero.
// ============================================================

// The user's own hero row for each match (one per match, where identifiable).
export function userHeroRows(rows: CombatFactRow[]): CombatFactRow[] {
  const byMatch = new Map<number, CombatFactRow>()
  for (const r of rows) {
    if (r.scoreboard_hero != null && r.hero_name === r.scoreboard_hero && !byMatch.has(r.match_id)) {
      byMatch.set(r.match_id, r)
    }
  }
  return Array.from(byMatch.values())
}

// DPS final-blow %: final_blows / user_elims, per match (user hero row). Both
// must be present and elims > 0. Returned per match + an overall average.
export interface FinalBlowStat {
  perMatch: { match_id: number; pct: number; result: Result | null; t: number; clamped: boolean }[]
  avgPct: number | null
  withData: number
  total: number
}
export function finalBlowRate(rows: CombatFactRow[]): FinalBlowStat {
  const userRows = userHeroRows(rows)
  const perMatch: { match_id: number; pct: number; result: Result | null; t: number; clamped: boolean }[] = []
  for (const r of userRows) {
    const fb = num(r.final_blows)
    const elims = num(r.user_elims)
    const t = parseTime(r.played_at)
    if (fb == null || elims == null || elims <= 0 || t == null) continue
    const raw = Math.round((fb / elims) * 1000) / 10
    // OCR can over-read final_blows above the elim count → impossible >100%.
    // Clamp for display honesty, flagging so the page can mark it.
    const clamped = raw > 100
    const pct = clamped ? 100 : raw
    perMatch.push({ match_id: r.match_id, pct, result: r.result, t, clamped })
  }
  perMatch.sort((a, b) => a.t - b.t)
  return {
    perMatch,
    avgPct: mean(perMatch.map(p => p.pct)),
    withData: perMatch.length,
    total: userRows.length,
  }
}

// ============================================================
// #7 — TEAM TOTAL DAMAGE: my team vs the enemy team, per match. Reads the
// pre-summed ally_total_damage / enemy_total_damage off the user hero row (one
// row per match). A match contributes only when BOTH totals are present (so the
// 5v5/6v6 difference doesn't matter — these are whole-team sums either way).
// Returns per-match points (chronological) plus the two overall averages, so the
// page can show a grouped bar chart and a headline "you out-damage the enemy in
// X% of games" figure.
// ============================================================
export interface TeamDamagePoint {
  match_id: number
  ally: number
  enemy: number
  result: Result | null
  t: number
}
export interface TeamDamageComparison {
  perMatch: TeamDamagePoint[]
  avgAlly: number | null
  avgEnemy: number | null
  gamesAllyHigher: number   // games where my team out-damaged the enemy
  withData: number
  total: number
}
export function teamDamageComparison(rows: CombatFactRow[]): TeamDamageComparison {
  const userRows = userHeroRows(rows)
  const perMatch: TeamDamagePoint[] = []
  for (const r of userRows) {
    const ally = num(r.ally_total_damage)
    const enemy = num(r.enemy_total_damage)
    const t = parseTime(r.played_at)
    if (ally == null || enemy == null || t == null) continue
    perMatch.push({ match_id: r.match_id, ally, enemy, result: r.result, t })
  }
  perMatch.sort((a, b) => a.t - b.t)
  return {
    perMatch,
    avgAlly: mean(perMatch.map(p => p.ally)),
    avgEnemy: mean(perMatch.map(p => p.enemy)),
    gamesAllyHigher: perMatch.filter(p => p.ally > p.enemy).length,
    withData: perMatch.length,
    total: userRows.length,
  }
}

// ============================================================
// #8 — MY SHARE OF TEAM DEATHS, per match. Two framings from the same two
// numbers (my deaths + the ally team's total deaths, incl. mine):
//   (1) SHARE: my deaths / team total deaths → "how much of the dying is me?"
//   (2) VS TEAMMATE AVG: my deaths vs the average of my (teamSize-1) teammates
//       → "am I dying more or less than the others?"
// Only non-leaver games have a scoreboard, so leaver games never reach here
// (the page excludes them before calling). A match contributes only when the
// team total is present and > 0. Team size is inferred from the match format
// (5 ally players in 5v5, 6 in 6v6) so the teammate average excludes me.
// ============================================================
export interface DeathSharePoint {
  match_id: number
  myDeaths: number
  teamDeaths: number
  sharePct: number          // my deaths as a % of team total (0..100)
  teammateAvg: number | null // avg deaths of my teammates (null if size unknown)
  result: Result | null
  t: number
}
export interface DeathShareSummary {
  perMatch: DeathSharePoint[]
  avgSharePct: number | null      // average of the per-game shares
  myAvgDeaths: number | null      // my mean deaths per game
  teammateAvgDeaths: number | null // mean teammate deaths per game (pooled)
  withData: number
  total: number
}
export function deathShare(rows: CombatFactRow[]): DeathShareSummary {
  const userRows = userHeroRows(rows)
  const perMatch: DeathSharePoint[] = []
  for (const r of userRows) {
    const mine = num(r.user_deaths)
    const team = num(r.ally_total_deaths)
    const t = parseTime(r.played_at)
    if (mine == null || team == null || team <= 0 || t == null) continue
    // ally team size: 5 in 5v5, 6 in 6v6 (the user is one of them).
    const allySize = r.match_format === '6v6' ? 6 : 5
    const teammates = allySize - 1
    const teammateAvg = teammates > 0 ? Math.round(((team - mine) / teammates) * 100) / 100 : null
    perMatch.push({
      match_id: r.match_id,
      myDeaths: mine,
      teamDeaths: team,
      sharePct: Math.round((mine / team) * 1000) / 10,
      teammateAvg,
      result: r.result,
      t,
    })
  }
  perMatch.sort((a, b) => a.t - b.t)
  const teammateVals = perMatch.map(p => p.teammateAvg).filter((v): v is number => v != null)
  return {
    perMatch,
    avgSharePct: mean(perMatch.map(p => p.sharePct)),
    myAvgDeaths: mean(perMatch.map(p => p.myDeaths)),
    teammateAvgDeaths: mean(teammateVals),
    withData: perMatch.length,
    total: userRows.length,
  }
}

// Final-blow % broken down per hero the user played (across all their rows, not
// just the scoreboard hero — a hero appears if it has final_blows + a usable
// elim figure on its own row). NOTE: user_elims is the user's MATCH total, so a
// true per-hero FB% isn't available when multiple heroes were played; we only
// compute per-hero FB% for single-hero matches (is_single_hero) to stay honest,
// and otherwise report the hero's final_blows as a raw count.
export interface HeroFinalBlows {
  hero: string
  fbPct: number | null     // only when derivable (single-hero matches pooled)
  totalFinalBlows: number
  games: number
  lowConfidence: boolean
}
export function finalBlowsByHero(rows: CombatFactRow[], minGames: number = MIN_GAMES, playtimePct = 95): HeroFinalBlows[] {
  const byHero = new Map<string, { fb: number; elimsForPct: number; fbForPct: number; pctGames: number; games: number }>()
  for (const r of rows) {
    const hero = r.hero_name
    const fb = num(r.final_blows)
    if (hero == null || fb == null) continue
    if (!byHero.has(hero)) byHero.set(hero, { fb: 0, elimsForPct: 0, fbForPct: 0, pctGames: 0, games: 0 })
    const b = byHero.get(hero)!
    b.fb += fb
    b.games++
    // only use single-hero matches for the FB% (elims attributable to this hero)
    const elims = num(r.user_elims)
    // Live single-hero cut: percent_played >= playtimePct (default 95 == the
    // frozen is_single_hero flag). Fall back to the flag if percent is null.
    const pp = num(r.percent_played)
    const singleHero = pp != null ? pp >= playtimePct : r.is_single_hero === true
    if (singleHero && elims != null && elims > 0) {
      b.fbForPct += fb
      b.elimsForPct += elims
      b.pctGames++
    }
  }
  return Array.from(byHero.entries())
    .map(([hero, b]) => ({
      hero,
      fbPct: b.elimsForPct > 0 ? Math.round((b.fbForPct / b.elimsForPct) * 1000) / 10 : null,
      totalFinalBlows: b.fb,
      games: b.games,
      lowConfidence: b.games < minGames,
    }))
    .sort((a, b) => b.totalFinalBlows - a.totalFinalBlows)
}

// Generic role-specific simple stat (solo kills, players saved): per-match value
// from the user's hero row, with average + coverage. `field` picks the column;
// `isDuration` routes through parseDuration for obj_contest_time.
export interface SimpleStat {
  perMatch: { match_id: number; value: number; result: Result | null; t: number }[]
  avg: number | null
  withData: number
  total: number
}
export function userStat(
  rows: CombatFactRow[],
  field: (r: CombatFactRow) => string | number | null,
  isDuration = false,
): SimpleStat {
  const userRows = userHeroRows(rows)
  const perMatch: { match_id: number; value: number; result: Result | null; t: number }[] = []
  for (const r of userRows) {
    const raw = field(r)
    const v = isDuration ? parseDuration(raw) : num(raw)
    const t = parseTime(r.played_at)
    if (v == null || t == null) continue
    perMatch.push({ match_id: r.match_id, value: v, result: r.result, t })
  }
  perMatch.sort((a, b) => a.t - b.t)
  return { perMatch, avg: mean(perMatch.map(p => p.value)), withData: perMatch.length, total: userRows.length }
}

// Overall win rate over deduped matches (draws excluded from %, counted in N).
export function overallWinRate(matches: MatchRow[]): number | null {
  const t = emptyTally()
  for (const m of matches) add(t, m.result)
  const decisive = t.wins + t.losses
  return decisive > 0 ? Math.round((t.wins / decisive) * 1000) / 10 : null
}

// ============================================================
// HERO → ROLE MAP (for 6v6 role filtering).
// In 6v6 a match has multiple roles, so role_played (single) can't filter within
// a game. We map each hero the user played to its role via the static roster.
// The caller injects the roster (from @/data/reference) so the lib stays pure.
// ============================================================
export type HeroRoleMap = Map<string, Role>
export function buildHeroRoleMap(heroes: { name: string; role: Role }[]): HeroRoleMap {
  return new Map(heroes.map(h => [h.name, h.role]))
}
// The role the user played in a fact row, via its hero (scoreboard_hero if set,
// else hero_name). Null when unknown.
export function rowUserRole(r: CombatFactRow, heroRole: HeroRoleMap): Role | null {
  const hero = r.scoreboard_hero ?? r.hero_name
  if (hero == null) return null
  return heroRole.get(hero) ?? null
}

// ============================================================
// SHARE DRILL-DOWN — share by mode / map / hero, chosen by the active filter
// depth. Each bucket: avg of the role-appropriate share over matches in it.
// Operates on deduped MatchRows that already carry the share for the role, but
// we also need the row's mode/map/hero — so this works off the FACT rows,
// deduped here with the dimension key attached.
// ============================================================
export type DrillDimension = 'mode' | 'map' | 'hero' | 'none'

// Decide the drill dimension from which filters are active.
//
// (v1.1.0 Phase 4) A hero filter USED TO return 'none' unconditionally, so
// picking a hero removed the damage / healing / mitigation share chart entirely.
// That is the wrong instinct: "how does my Ana healing share vary BY MODE" is a
// perfectly good question, and it was the one thing the chart could still answer.
//
// The hero branch now drills by the coarsest dimension that is NOT already
// filtered, and returns 'none' only when nothing is left to vary across. A map
// filter counts as pinning the mode too — a map has exactly one mode, so drilling
// by mode under a map filter would draw a single bar.
//
// ⚠️ Every NON-hero path is unchanged, deliberately. The original order drills
// DOWN from the most specific active filter (map → hero, mode → map). Rewriting
// the whole thing as "first unfiltered dimension" would have made a map filter
// drill by mode, i.e. that single-bar chart. Only the hero branch is new.
export function drillDimension(modeActive: boolean, mapActive: boolean, heroActive: boolean): DrillDimension {
  if (heroActive) {
    if (mapActive) return 'none'  // map pins the mode as well — nothing left to vary
    if (modeActive) return 'map'
    return 'mode'
  }
  if (mapActive) return 'hero'
  if (modeActive) return 'map'
  return 'mode'
}

export interface DrillRow {
  key: string            // the bucket (mode name / map name / hero name)
  avgShare: number | null
  games: number          // matches with a non-null share in this bucket
  lowConfidence: boolean
}

// Build the drill chart. `rows` are the filtered fact rows; `role` picks the
// share; `dim` picks the bucketing key. Dedupes to one row per match first
// (shares are whole-match), then groups by the dimension. For 'hero' we use the
// user's actual hero (scoreboard_hero) so it's "share in games I played hero X".
export function shareDrill(rows: CombatFactRow[], role: Role, dim: DrillDimension, minGames: number = MIN_GAMES): DrillRow[] {
  if (dim === 'none') return []
  const shareCol = (r: CombatFactRow): number | null =>
    role === 'tank' ? num(r.mitigation_pct) : role === 'dps' ? num(r.damage_pct) : num(r.healing_pct)
  const keyOf = (r: CombatFactRow): string | null => {
    if (dim === 'mode') return r.game_mode
    if (dim === 'map') return r.map
    return r.scoreboard_hero ?? r.hero_name // hero
  }
  // dedupe to one row per match, keeping the user's hero row
  const byMatch = new Map<number, CombatFactRow>()
  for (const r of rows) {
    const isUser = r.scoreboard_hero != null && r.hero_name === r.scoreboard_hero
    if (!byMatch.has(r.match_id) || isUser) byMatch.set(r.match_id, r)
  }
  const buckets = new Map<string, number[]>()
  for (const r of byMatch.values()) {
    const key = keyOf(r)
    const share = shareCol(r)
    if (key == null || share == null) continue
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(share)
  }
  return Array.from(buckets.entries())
    .map(([key, vals]) => ({
      key, avgShare: mean(vals), games: vals.length,
      lowConfidence: vals.length < minGames,
    }))
    .sort((a, b) => (b.avgShare ?? -1) - (a.avgShare ?? -1))
}

// ============================================================
// SHARE BY SESSION — avg role share per play session. Sessions split on a 45-min
// gap (same convention as the Time page). A session with NO non-null shares for
// this role (e.g. a session played as a different role) is DROPPED, not shown as
// 0. Returns chronological session points.
// ============================================================
export const SESSION_GAP_MS = 45 * 60 * 1000
export interface SessionSharePoint {
  index: number          // 1-based session number among the KEPT sessions
  label: string          // "S1", "S2", … (kept-session numbering)
  avgShare: number
  games: number          // games with a share in the session
  startMs: number
}
export function shareBySession(matches: MatchRow[]): SessionSharePoint[] {
  // order chronologically
  const ordered = matches
    .map(m => ({ m, t: parseTime(m.played_at) }))
    .filter((x): x is { m: MatchRow; t: number } => x.t != null)
    .sort((a, b) => a.t - b.t)
  // split into sessions on the 45-min gap
  const sessions: { m: MatchRow; t: number }[][] = []
  let cur: { m: MatchRow; t: number }[] = []
  let prev: number | null = null
  for (const x of ordered) {
    if (prev != null && x.t - prev >= SESSION_GAP_MS) { sessions.push(cur); cur = [] }
    cur.push(x); prev = x.t
  }
  if (cur.length) sessions.push(cur)
  // average share per session, dropping sessions with no share data for this role
  const out: SessionSharePoint[] = []
  for (const sess of sessions) {
    const vals = sess.map(x => x.m.share).filter((v): v is number => v != null)
    if (vals.length === 0) continue // drop role-absent sessions
    out.push({
      index: 0, label: '', avgShare: mean(vals)!, games: vals.length, startMs: sess[0].t,
    })
  }
  // renumber the kept sessions 1..n
  return out.map((p, i) => ({ ...p, index: i + 1, label: `S${i + 1}` }))
}

// ============================================================
// RATE FRAMING — per-game average, per-minute, per-30-seconds for a hero-grain
// count stat, divided by the row's eff_play_time_seconds. Null time → that row
// is dropped from the per-time rates (but still counts for per-game average if
// the value is present). Coverage reported separately for game vs time bases.
// ============================================================
export interface RateStat {
  perGameAvg: number | null   // avg raw count per game (value present)
  perMinute: number | null    // avg of (value / minutes) across rows with time
  per30Sec: number | null     // perMinute / 2 equivalent, but averaged per-row
  gameCoverage: { withData: number; total: number }
  timeCoverage: { withData: number; total: number }
}
export function rateStat(
  rows: CombatFactRow[],
  value: (r: CombatFactRow) => string | number | null,
  isDuration = false,
): RateStat {
  const userRows = userHeroRows(rows)
  const counts: number[] = []
  const perMin: number[] = []
  const per30: number[] = []
  let timeWith = 0
  for (const r of userRows) {
    const v = isDuration ? parseDuration(value(r)) : num(value(r))
    if (v != null) counts.push(v)
    const secs = num(r.eff_play_time_seconds)
    if (v != null && secs != null && secs > 0) {
      perMin.push(v / (secs / 60))
      per30.push(v / (secs / 30))
      timeWith++
    }
  }
  const round2 = (n: number | null) => n == null ? null : Math.round(n * 100) / 100
  return {
    perGameAvg: round2(mean(counts)),
    perMinute: round2(mean(perMin)),
    per30Sec: round2(mean(per30)),
    gameCoverage: { withData: counts.length, total: userRows.length },
    timeCoverage: { withData: timeWith, total: userRows.length },
  }
}

// ============================================================
// PER-HERO RATE BREAKDOWN — average per game + per-minute + per-30s for ANY
// hero-grain stat (final blows, obj contest time, players saved), divided by
// each hero row's eff_play_time_seconds. One row per hero (across all the user's
// rows on that hero). Null-time rows drop from the rate columns but still count
// toward the per-game average. `isDuration` routes obj_contest_time through the
// MM:SS parser.
// ============================================================
export interface HeroRateRow {
  hero: string
  avgPerGame: number | null
  perMinute: number | null
  per30Sec: number | null
  games: number
  timeGames: number
  lowConfidence: boolean
}
export function ratesByHero(
  rows: CombatFactRow[],
  value: (r: CombatFactRow) => string | number | null,
  isDuration = false,
  minGames: number = MIN_GAMES,
): HeroRateRow[] {
  const byHero = new Map<string, { counts: number[]; perMin: number[]; per30: number[]; timeGames: number }>()
  for (const r of rows) {
    const hero = r.hero_name
    const v = isDuration ? parseDuration(value(r)) : num(value(r))
    if (hero == null || v == null) continue
    if (!byHero.has(hero)) byHero.set(hero, { counts: [], perMin: [], per30: [], timeGames: 0 })
    const b = byHero.get(hero)!
    b.counts.push(v)
    const secs = num(r.eff_play_time_seconds)
    if (secs != null && secs > 0) {
      b.perMin.push(v / (secs / 60))
      b.per30.push(v / (secs / 30))
      b.timeGames++
    }
  }
  const round2 = (n: number | null) => n == null ? null : Math.round(n * 100) / 100
  return Array.from(byHero.entries())
    .map(([hero, b]) => ({
      hero,
      avgPerGame: round2(mean(b.counts)),
      perMinute: round2(mean(b.perMin)),
      per30Sec: round2(mean(b.per30)),
      games: b.counts.length,
      timeGames: b.timeGames,
      lowConfidence: b.counts.length < minGames,
    }))
    .sort((a, b) => (b.avgPerGame ?? -1) - (a.avgPerGame ?? -1))
}

// ============================================================
// FINAL BLOWS BY HERO — AVERAGE per game (not cumulative), plus per-minute and
// per-30s using each hero row's eff_play_time_seconds. One row per hero (across
// all the user's rows on that hero). Null time rows drop from the rate columns.
// ============================================================
export interface HeroFinalBlowRates {
  hero: string
  avgPerGame: number | null
  perMinute: number | null
  per30Sec: number | null
  games: number
  timeGames: number       // games with usable time (for the rate columns)
  lowConfidence: boolean
}
export function finalBlowRatesByHero(rows: CombatFactRow[], minGames: number = MIN_GAMES): HeroFinalBlowRates[] {
  const byHero = new Map<string, { counts: number[]; perMin: number[]; per30: number[]; timeGames: number }>()
  for (const r of rows) {
    const hero = r.hero_name
    const fb = num(r.final_blows)
    if (hero == null || fb == null) continue
    if (!byHero.has(hero)) byHero.set(hero, { counts: [], perMin: [], per30: [], timeGames: 0 })
    const b = byHero.get(hero)!
    b.counts.push(fb)
    const secs = num(r.eff_play_time_seconds)
    if (secs != null && secs > 0) {
      b.perMin.push(fb / (secs / 60))
      b.per30.push(fb / (secs / 30))
      b.timeGames++
    }
  }
  const round2 = (n: number | null) => n == null ? null : Math.round(n * 100) / 100
  return Array.from(byHero.entries())
    .map(([hero, b]) => ({
      hero,
      avgPerGame: round2(mean(b.counts)),
      perMinute: round2(mean(b.perMin)),
      per30Sec: round2(mean(b.per30)),
      games: b.counts.length,
      timeGames: b.timeGames,
      lowConfidence: b.counts.length < minGames,
    }))
    .sort((a, b) => (b.avgPerGame ?? -1) - (a.avgPerGame ?? -1))
}

// ============================================================
// 6v6 ROLE FILTER — keep only fact rows whose user-hero role is in the selected
// set. Empty set = no filter (all rows). Used by the page's 6v6 local control so
// 6v6 can show the same per-role breakdown as the 5v5 queue.
// ============================================================
export function filterBySixRoles(rows: CombatFactRow[], roles: Set<Role>, heroRole: HeroRoleMap): CombatFactRow[] {
  if (roles.size === 0) return rows
  return rows.filter(r => {
    const role = rowUserRole(r, heroRole)
    return role != null && roles.has(role)
  })
}
