// ============================================================
// SESSION MATCH — from a grouped match to what /process saves (v1.2.0)
// ------------------------------------------------------------
// A session match has no upload wizard behind it, so everything the wizard
// used to supply is derived here instead:
//   • format        — from the Teams page row counts (session-grouper)
//   • role(s)       — from the heroes played, at the match date (heroRoleAt)
//   • leavers       — permanent only: a side with a dropped row (the grouper)
//   • questions     — none; the columns are left NULL. Returned leavers and
//                     throwers can't be detected from screenshots and are
//                     recorded as 'none' / false (accepted by the user).
//
// Also the AUTO-SAVE GATE (sessionMatchExceptions): a match saves without
// review only when nothing structural is in doubt. There is no per-slot hero
// review in bulk mode (user decision, Season 5). Its replacement is the 5v5
// team-shape check — competitive 5v5 is always 1-2-2, so any other shape means
// a misread hero and holds the match for the existing hero audit. On the beta
// season's 93 matches that would have caught 15 of the 18 hero errors.
//
// Pure (types only from the pipeline modules).
// ============================================================

import { heroRoleAt, type HeroRole } from '@/data/reference'
import type { ProcessedMatch } from '@/lib/image-processor'
import type { LeaverType } from '@/lib/types'
import type { SessionMatch } from '@/lib/session-grouper'

/** Assignable to /process's PendingBatch['metadata']. */
export interface SessionBatchMetadata {
  source: 'session'
  session_id: string
  role_played: HeroRole | null
  match_format: '5v5' | '6v6'
  roles_played: HeroRole[]
  question_scale_version: 2
  matchup_feel: null
  performance_rating: null
  fun_rating_6: null
  team_leaver_type: LeaverType
  enemy_leaver_type: LeaverType
  impressed_ally_slots: number[]
  struggled_enemy_slots: number[]
  team_leaver: boolean
  team_thrower: boolean
  enemy_leaver: boolean
  enemy_thrower: boolean
  has_leaver: boolean
  personal_thoughts: null
  starting_side: null
  detected_map: string | null
  map_detect_missed: boolean
  uploaded_at: string
  photo_count: number
}

/** Heroes beyond the Summary's top three, for processMatchPhotos' extraHeroes:
 *  the sidebar's names when it lists 4+ heroes, otherwise nothing. */
export function sessionExtraHeroes(m: SessionMatch): string[] | undefined {
  if (m.sidebar.length <= 3) return undefined
  return m.sidebar.filter((h): h is string => h != null)
}

/** Heroes the user played, longest first — breakdown play time where known,
 *  else the Summary's order (which is already longest first). */
export function heroesByPlayTime(processed: ProcessedMatch): string[] {
  const time = new Map(processed.heroBreakdowns.map(b => [b.heroName, b.playTimeSeconds ?? -1]))
  return processed.heroes
    .map((h, i) => ({ name: h.name, t: time.get(h.name) ?? -1, i }))
    .sort((a, b) => (b.t - a.t) || (a.i - b.i))
    .map(h => h.name)
}

/** The user's role(s) for the match, from the heroes played at its date. */
export function rolesFromHeroes(processed: ProcessedMatch): { role: HeroRole | null; roles: HeroRole[] } {
  const roles: HeroRole[] = []
  for (const name of heroesByPlayTime(processed)) {
    const r = heroRoleAt(name, processed.matchTimestamp)
    if (r && !roles.includes(r)) roles.push(r)
  }
  return { role: roles[0] ?? null, roles }
}

export function sessionMatchMetadata(
  sessionId: string,
  m: SessionMatch,
  processed: ProcessedMatch,
  uploadedAt: string,
): SessionBatchMetadata {
  const { role, roles } = rolesFromHeroes(processed)
  const format = m.format ?? processed.matchFormat ?? '5v5'
  const teamType: LeaverType = m.leaver.team ? 'left' : 'none'
  const enemyType: LeaverType = m.leaver.enemy ? 'left' : 'none'
  return {
    source: 'session',
    session_id: sessionId,
    role_played: role,
    match_format: format,
    roles_played: format === '6v6' ? roles : (role ? [role] : []),
    question_scale_version: 2,
    matchup_feel: null,
    performance_rating: null,
    fun_rating_6: null,
    team_leaver_type: teamType,
    enemy_leaver_type: enemyType,
    impressed_ally_slots: [],
    struggled_enemy_slots: [],
    team_leaver: teamType !== 'none',
    team_thrower: false,
    enemy_leaver: enemyType !== 'none',
    enemy_thrower: false,
    has_leaver: teamType === 'left' || enemyType === 'left',
    personal_thoughts: null,
    starting_side: null,
    detected_map: processed.mapName ?? m.mapName,
    map_detect_missed: !(processed.mapName ?? m.mapName),
    uploaded_at: uploadedAt,
    photo_count: 1 + m.personalIds.length + (m.teamsId ? 1 : 0),
  }
}

/** "T-D-S" counts for one side of the scoreboard, using each hero's role on
 *  the match date; null if any row on that side has no hero. */
export function teamShape(processed: ProcessedMatch, team: 'ally' | 'enemy'): string | null {
  const sb = processed.scoreboard
  if (!sb) return null
  const rows = sb.stats.filter(s => s.team === team)
  const n = { tank: 0, dps: 0, support: 0 }
  for (const s of rows) {
    const r = s.heroName ? heroRoleAt(s.heroName, processed.matchTimestamp) : undefined
    if (!r) return null
    n[r]++
  }
  return `${n.tank}-${n.dps}-${n.support}`
}

/**
 * Re-derive every scoreboard row's role for the match's date, then rebuild
 * the team comps — the same rule onAuditComplete applies before any save.
 * Extraction hands rows their CURRENT role; a hero whose role changed (Sombra,
 * Season 5) must be saved with the role it had when the match was played.
 * Mutates and returns `result`.
 */
export function applyMatchDateRoles(result: ProcessedMatch): ProcessedMatch {
  const sb = result.scoreboard
  if (!sb) return result
  const playedAt = result.matchTimestamp ?? new Date()
  for (const st of sb.stats) {
    const role = st.heroName ? heroRoleAt(st.heroName, playedAt) : undefined
    if (role && st.role !== role) {
      st.role = role
      for (const r of sb.roles) if (r.slot === st.slot) r.role = role
    }
  }
  const ally = teamShape(result, 'ally')
  const enemy = teamShape(result, 'enemy')
  if (ally) result.allyComp = ally
  if (enemy) result.enemyComp = enemy
  return result
}

/**
 * Why this match can't be saved automatically — empty means it can. Runs on
 * the PROCESSED match (after the full pipeline), on top of the grouping
 * issues the grouper already found.
 */
export function sessionMatchExceptions(m: SessionMatch, processed: ProcessedMatch): string[] {
  const out = [...m.issues]
  const leaverGame = m.leaver.team || m.leaver.enemy

  if (!processed.mapName) out.push('Map not recognised')
  if (!processed.result) out.push('Result not read')
  if (!processed.matchTimestamp) out.push('Match date not read')
  if (processed.heroes.length === 0) out.push('No heroes identified on the Summary')

  const { roles } = rolesFromHeroes(processed)
  const format = m.format ?? processed.matchFormat
  if (format === '5v5' && roles.length > 1) {
    out.push(`Your heroes span ${roles.join(' + ')} in a 5v5 (role queue) game — a hero is likely misread`)
  }

  if (!leaverGame && m.teamsId) {
    const sb = processed.scoreboard
    if (!sb) {
      out.push('Scoreboard could not be read')
    } else {
      if (sb.ocrAnalysis && !sb.ocrAnalysis.resolved) out.push('Your row on the scoreboard needs confirming')
      if (format === '5v5') {
        const ally = teamShape(processed, 'ally')
        const enemy = teamShape(processed, 'enemy')
        if (ally !== '1-2-2' || enemy !== '1-2-2') {
          out.push(`Team shape reads ${ally ?? '?'} v ${enemy ?? '?'} (competitive 5v5 is 1-2-2) — check heroes`)
        }
      }
    }
  }
  return Array.from(new Set(out))
}
