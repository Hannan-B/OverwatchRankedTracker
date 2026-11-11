// ============================================================
// SESSION GROUPER — sort a session's screenshots into matches (v1.2.0)
// ------------------------------------------------------------
// Pure: fingerprints in (session-fingerprint.ts), matches + leftovers out.
// No file order, file names or dates are used — the PS App → Photos path
// can't be trusted to preserve any of them.
//
//   1. Each SUMMARY anchors one match, keyed by its on-screen date/time.
//      A second Summary with the same date, map and result is a duplicate.
//   2. Each TEAMS page joins the match whose Summary E/A/D equals the user's
//      row E/A/D (the Summary's "Total performance" and the Teams row are the
//      same three numbers). No candidate, or more than one → leftover.
//   3. Each PERSONAL page joins the match with a hero slot of the same
//      % played AND play time. The Summary only shows the top three heroes, so
//      the remaining pages join through the SIDEBAR: every Personal page of a
//      match lists the same heroes, so a page whose sidebar equals that of an
//      already-placed page belongs to the same match — if exactly one match has
//      that sidebar.
//   4. Format and leavers come from the Teams page's row counts. A permanent
//      leaver's row is dropped from the match-history board, so a side with
//      fewer rows than the format had a leaver.
//
// Exact agreement or nothing: a misread digit breaks a link rather than making
// a wrong one, and the screenshot surfaces as a leftover with its reason.
// ============================================================

import type { Fingerprint, Ead } from '@/lib/session-fingerprint'

type SummaryFp = Extract<Fingerprint, { kind: 'summary' }>
type PersonalFp = Extract<Fingerprint, { kind: 'personal' }>
type TeamsFp = Extract<Fingerprint, { kind: 'teams' }>

export type Format = '5v5' | '6v6'

export interface SessionMatch {
  /** The Summary's id — stable for the life of the session. */
  key: string
  summaryId: string
  /** Personal pages, in sidebar order where known. */
  personalIds: string[]
  teamsId: string | null
  mapName: string | null
  result: 'victory' | 'defeat' | 'draw' | null
  score: string | null
  dateText: string | null
  playedAt: string | null
  ead: Ead | null
  /** Heroes played, from the sidebar (or the Summary's filled slots). */
  heroesExpected: number
  sidebar: (string | null)[]
  format: Format | null
  /** False when the format had to be inferred from row spacing alone. */
  formatCertain: boolean
  /** Rows listed per side on the Teams page (null without one). */
  allyRows: number | null
  enemyRows: number | null
  /** A side with fewer rows than the format = a permanent leaver on it. */
  leaver: { team: boolean; enemy: boolean }
  /** Reasons this match can't be saved without the user looking at it. */
  issues: string[]
  /** Worth showing, but don't stop an automatic save. */
  notes: string[]
}

export interface Leftover {
  id: string
  reason: string
}

export interface SessionGrouping {
  matches: SessionMatch[]
  /** Screenshots that didn't fit exactly one match — never guessed. */
  leftovers: Leftover[]
  /** Exact repeats of a screenshot already placed (safe to ignore). */
  duplicates: Leftover[]
}

// Row spacing on match-history boards: ~130px on 5v5 (measured, Season 5).
// 6v6 rows are shorter; anything under this is read as 6v6 when the row COUNT
// alone can't decide (both sides lost players). Calibrate against real 6v6
// history boards.
export const SIXV6_MAX_PITCH = 124

const eadEqual = (a: Ead | null, b: Ead | null): boolean =>
  !!a && !!b && a.e != null && a.a != null && a.d != null && a.e === b.e && a.a === b.a && a.d === b.d

const sidebarSig = (s: (string | null)[]): string | null =>
  s.length > 0 && s.every(n => n != null) ? s.join('|') : null

export function formatFromRows(
  allyRows: number,
  enemyRows: number,
  pitch: number | null,
): { format: Format | null; certain: boolean } {
  const most = Math.max(allyRows, enemyRows)
  if (most >= 6) return { format: '6v6', certain: true }
  if (most === 0) return { format: null, certain: false }
  const shortPitch = pitch != null && pitch < SIXV6_MAX_PITCH
  if (most === 5) return shortPitch ? { format: '6v6', certain: false } : { format: '5v5', certain: true }
  // Both sides short: only the row spacing can tell the formats apart.
  if (pitch == null) return { format: null, certain: false }
  return { format: shortPitch ? '6v6' : '5v5', certain: false }
}

/** A choice made on the grouping preview: put screenshot `id` into the match
 *  keyed by a Summary id, or IGNORE it. Applied before the automatic rules. */
export const IGNORE = '__ignore__'
export type ManualPlacements = Record<string, string>

export function groupSession(fps: Fingerprint[], manual: ManualPlacements = {}): SessionGrouping {
  const leftovers: Leftover[] = []
  const duplicates: Leftover[] = []

  const ignored = new Set(Object.keys(manual).filter(id => manual[id] === IGNORE))
  for (const id of ignored) duplicates.push({ id, reason: 'Ignored by you' })
  fps = fps.filter(f => !ignored.has(f.id))

  for (const f of fps) if (f.kind === 'unknown') leftovers.push({ id: f.id, reason: f.reason })

  // ---- 1. Summaries anchor matches ----
  const summaries: SummaryFp[] = []
  for (const f of fps) {
    if (f.kind !== 'summary') continue
    const twin = f.dateText
      ? summaries.find(s => s.dateText === f.dateText && s.mapName === f.mapName && s.result === f.result)
      : undefined
    if (twin) duplicates.push({ id: f.id, reason: `Same Summary as another screenshot (${f.dateText})` })
    else summaries.push(f)
  }

  const personalOf = new Map<string, PersonalFp[]>(summaries.map(s => [s.id, []]))
  const teamsOf = new Map<string, TeamsFp>()

  const summaryIds = new Set(summaries.map(s => s.id))
  const placedByHand = (f: Fingerprint): string | null => {
    const target = manual[f.id]
    return target && summaryIds.has(target) ? target : null
  }

  // ---- 2. Teams pages, by the user's E/A/D (your placements first) ----
  for (const f of fps) {
    if (f.kind !== 'teams') continue
    const hand = placedByHand(f)
    if (hand) {
      const prev = teamsOf.get(hand)
      if (prev) leftovers.push({ id: prev.id, reason: 'Teams page replaced by the one you placed' })
      teamsOf.set(hand, f)
    }
  }
  for (const f of fps) {
    if (f.kind !== 'teams' || placedByHand(f)) continue
    if (!f.userEad || f.userEad.e == null || f.userEad.a == null || f.userEad.d == null) {
      leftovers.push({ id: f.id, reason: 'Teams page: your row or its E/A/D could not be read' })
      continue
    }
    const cands = summaries.filter(s => eadEqual(s.ead, f.userEad))
    const ead = `${f.userEad.e}/${f.userEad.a}/${f.userEad.d}`
    if (cands.length === 0) {
      leftovers.push({ id: f.id, reason: `Teams page (${ead}): no Summary with the same E/A/D` })
    } else if (cands.length > 1) {
      leftovers.push({ id: f.id, reason: `Teams page (${ead}): ${cands.length} matches share this E/A/D` })
    } else if (teamsOf.has(cands[0].id)) {
      // (also covers a match whose Teams page you placed by hand)
      duplicates.push({ id: f.id, reason: `Second Teams page for the ${cands[0].dateText ?? 'same'} match` })
    } else {
      teamsOf.set(cands[0].id, f)
    }
  }

  // ---- 3a. Personal pages, by % played + play time against Summary slots ----
  const unplaced: PersonalFp[] = []
  for (const f of fps) {
    if (f.kind !== 'personal') continue
    const hand = placedByHand(f)
    if (hand) { personalOf.get(hand)!.push(f); continue }
    if (f.percentPlayed == null || f.playTimeSeconds == null) { unplaced.push(f); continue }
    const cands = summaries.filter(s =>
      s.slots.some(sl => sl.percentPlayed === f.percentPlayed && sl.playTimeSeconds === f.playTimeSeconds))
    if (cands.length === 1) personalOf.get(cands[0].id)!.push(f)
    else unplaced.push(f)
  }

  // ---- 3b. Remaining pages through the sidebar ----
  let progress = true
  while (progress && unplaced.length > 0) {
    progress = false
    for (let i = unplaced.length - 1; i >= 0; i--) {
      const f = unplaced[i]
      const sig = sidebarSig(f.sidebar)
      if (!sig) continue
      const cands = summaries.filter(s => (personalOf.get(s.id) ?? []).some(p => sidebarSig(p.sidebar) === sig))
      if (cands.length === 1) {
        personalOf.get(cands[0].id)!.push(f)
        unplaced.splice(i, 1)
        progress = true
      }
    }
  }
  for (const f of unplaced) {
    const what = f.hero ? `Personal page (${f.hero})` : 'Personal page'
    const reason = f.percentPlayed == null || f.playTimeSeconds == null
      ? `${what}: % played / play time could not be read`
      : `${what}: no single match fits (${f.percentPlayed}% · ${f.playTimeSeconds}s)`
    leftovers.push({ id: f.id, reason })
  }

  // ---- 4. Per match: duplicates, format, leavers, checks ----
  const matches: SessionMatch[] = summaries.map(s => {
    const issues: string[] = []
    const notes: string[] = []

    // A page for the same sidebar position twice → the second is a repeat.
    const pages: PersonalFp[] = []
    for (const p of personalOf.get(s.id) ?? []) {
      const twin = pages.find(q =>
        (p.highlighted != null && q.highlighted === p.highlighted && sidebarSig(q.sidebar) === sidebarSig(p.sidebar)) ||
        (p.hero != null && q.hero === p.hero))
      if (twin) duplicates.push({ id: p.id, reason: `Second Personal page for ${p.hero ?? 'the same hero'}` })
      else pages.push(p)
    }
    pages.sort((a, b) => (a.highlighted ?? 99) - (b.highlighted ?? 99))

    // Sidebars must agree within a match.
    const sigs = new Set(pages.map(p => sidebarSig(p.sidebar)).filter((x): x is string => x != null))
    if (sigs.size > 1) issues.push('Personal pages list different heroes in their sidebars')
    const sidebar = pages.find(p => sidebarSig(p.sidebar))?.sidebar ?? pages[0]?.sidebar ?? []
    const heroesExpected = Math.max(sidebar.length, s.slots.length)

    if (pages.length < heroesExpected) {
      notes.push(`${heroesExpected - pages.length} of ${heroesExpected} Personal page(s) missing — those heroes' breakdown stats won't be saved`)
    } else if (pages.length === heroesExpected) {
      const pctSum = pages.reduce((n, p) => n + (p.percentPlayed ?? 0), 0)
      if (Math.abs(pctSum - 100) > 2) notes.push(`% played adds up to ${pctSum}, not 100`)
    }
    if (heroesExpected > 3) {
      notes.push(`${heroesExpected} heroes played — the Summary shows the top 3; the rest come from the Personal pages' sidebar`)
    }

    const t = teamsOf.get(s.id) ?? null
    let format: Format | null = null
    let formatCertain = false
    const leaver = { team: false, enemy: false }
    if (!t) {
      issues.push('No Teams page — format and leavers can\'t be worked out')
    } else {
      const f = formatFromRows(t.allyRows, t.enemyRows, t.pitch)
      format = f.format
      formatCertain = f.certain
      if (!format) issues.push('Format (5v5 / 6v6) could not be worked out from the Teams page')
      else {
        if (!formatCertain) issues.push(`Format read as ${format} from row spacing only — please confirm`)
        const full = format === '6v6' ? 6 : 5
        leaver.team = t.allyRows < full
        leaver.enemy = t.enemyRows < full
        if (leaver.team || leaver.enemy) {
          const who = [leaver.team && 'your team', leaver.enemy && 'the enemy team'].filter(Boolean).join(' and ')
          notes.push(`Leaver on ${who} (${t.allyRows} v ${t.enemyRows} rows) — scoreboard not used, as for any permanent leaver`)
        }
      }
    }

    if (!s.dateText || !s.playedAt) issues.push('Match date/time could not be read')
    if (!s.mapName) issues.push('Map could not be read')
    if (!s.result) issues.push('Result (victory / defeat / draw) could not be read')

    return {
      key: s.id,
      summaryId: s.id,
      personalIds: pages.map(p => p.id),
      teamsId: t?.id ?? null,
      mapName: s.mapName,
      result: s.result,
      score: s.score,
      dateText: s.dateText,
      playedAt: s.playedAt,
      ead: s.ead,
      heroesExpected,
      sidebar,
      format,
      formatCertain,
      allyRows: t?.allyRows ?? null,
      enemyRows: t?.enemyRows ?? null,
      leaver,
      issues,
      notes,
    }
  })

  matches.sort((a, b) => (a.playedAt ?? '').localeCompare(b.playedAt ?? ''))
  return { matches, leftovers, duplicates }
}
