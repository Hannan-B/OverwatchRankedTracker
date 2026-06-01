// ============================================================
// Step 6f — Beta confirmation layer
// ------------------------------------------------------------
// Post-processing verification. Runs AFTER processMatchPhotos() has produced a
// full extraction result; consumes that result + the confidence signals the
// pipeline already computes, and produces a small, priority-ranked list of
// confirmation questions (max 3, target ~2) for the review page to show.
//
// This module does NO extraction and NO OCR. It only reads already-computed
// signals:
//   - scoreboard vote-split / cell confidence  (SbCellConfidence, 6f extractor change)
//   - hero-ID confidence / margin              (ScoreboardOcrAnalysis, identifyHeroes)
//   - breakdown UNKNOWN tiles + avg cross-check (BreakdownOcrResult)
//   - summary fields, sampled on a ratio        (SummaryOcrResult)
//
// The confirmation UI is a generalization of the existing username-confirmation
// card (analyzeUserIdentity): crop + value + Correct/Fix-it.
// ============================================================

import type {
  ScoreboardOcrAnalysis,
  ScoreboardPlayerStats,
  ScoreboardGrid,
} from './types'
import type { SbCellConfidence } from './scoreboard-extractor'
import type { BreakdownOcrResult } from './breakdown-ocr'
import type { SummaryOcrResult } from './ocr-extractor'

// ── Signal + field taxonomy ──────────────────────────────────

export type SignalKind =
  | 'unrecognized'          // tier 1: UNKNOWN label / no catalog entry / unknown map-mode
  | 'vote_split'            // tier 2: scoreboard digit, multi-threshold disagreed
  | 'avg_crosscheck_fail'   // tier 2: breakdown value != avg * playtime/10min
  | 'low_hero_conf'         // tier 3: portrait match below confidence gate
  | 'phase_disagreement'    // tier 3: Phase-1 != Pass-1 hero ID
  | 'low_user_margin'       // tier 3: username best-vs-runner-up margin narrow
  | 'sampled_summary'       // tier 4: routine spot-check on a clean field

export type FieldKind =
  | 'scoreboard'
  | 'breakdown_stat'
  | 'hero_id'
  | 'summary'
  | 'username'

// Lower tier number = higher priority (filled first).
export const SIGNAL_TIER: Record<SignalKind, 1 | 2 | 3 | 4> = {
  unrecognized: 1,
  vote_split: 2,
  avg_crosscheck_fail: 2,
  low_hero_conf: 3,
  phase_disagreement: 3,
  low_user_margin: 3,
  sampled_summary: 4,
}

export interface HighlightRegion {
  /** Source screenshot URL to display. */
  imageUrl: string
  /** Optional highlight box as fractions of image width/height (0..1).
   *  When absent, the whole image is shown with no box. */
  box?: { x: number; y: number; w: number; h: number }
}

export interface ConfirmationCandidate {
  /** Stable id within a match, e.g. "scoreboard:slot3:mitigation". */
  id: string
  field: FieldKind
  /** Human label for the card, e.g. "Ally DPS 1 — Mitigation". */
  fieldDetail: string
  signal: SignalKind
  tier: 1 | 2 | 3 | 4
  /** Source image + optional highlight box the user verifies against.
   *  Null only when no source image was captured for this field. */
  region: HighlightRegion | null
  /** What the pipeline read, as a display string. */
  extractedValue: string
  /** 0..1 where available (lower = more suspect); undefined when not meaningful. */
  confidence?: number
  /** best-vs-runner-up margin where available (hero id / username). */
  margin?: number
  /** Free-form reason for logs/tooltip. */
  note?: string
}

// ── Config ───────────────────────────────────────────────────

export interface BetaConfirmConfig {
  maxQuestions: number          // hard ceiling
  targetQuestions: number       // soft target used by the sampled filler
  /** 1-in-N matches gets a sampled summary question when slots remain. */
  summarySampleEveryN: number
  /** avg cross-check tolerance band, fractional (0.15 = ±15%). */
  avgTolerance: number
  /** breakdown stats with playtime below this (seconds) skip the avg check —
   *  tiny denominators make the ratio meaningless. */
  avgMinPlaytimeSeconds: number
}

export const DEFAULT_CONFIG: BetaConfirmConfig = {
  maxQuestions: 3,
  targetQuestions: 2,
  summarySampleEveryN: 4,
  avgTolerance: 0.15,
  avgMinPlaytimeSeconds: 60,
}

// ── Inputs the builder reads ─────────────────────────────────
//
// Assembled by the review page from processMatchPhotos() output. Everything is
// optional so the builder degrades gracefully when a stage is absent (e.g. a
// match with no breakdown page).

export interface ConfirmInputs {
  matchId: string
  format: '5v5' | '6v6'
  /** Per-cell scoreboard confidence (from extractStats cellConfidenceOut). */
  scoreboardCells?: SbCellConfidence[]
  /** Final per-player stats, used to build positional labels for cards. */
  scoreboardStats?: ScoreboardPlayerStats[]
  /** Username identification result (margin / resolved). */
  userAnalysis?: ScoreboardOcrAnalysis
  /** Per-hero breakdown results (one per hero played). */
  breakdowns?: BreakdownOcrResult[]
  /** Summary page result. */
  summary?: SummaryOcrResult
  /** Hero-id slots flagged low-confidence during identifyHeroes (slot numbers). */
  lowConfHeroSlots?: number[]
  /** Slots where Phase-1 != Pass-1 hero id disagreed (slot numbers). */
  phaseDisagreementSlots?: number[]
  /** Reference lists for unrecognized map/mode detection. */
  knownMaps?: string[]
  knownModes?: string[]
  /** Source screenshot URLs for highlight display. */
  scoreboardImageUrl?: string
  summaryImageUrl?: string
  /** breakdown hero name → its source image URL. */
  breakdownImageUrlByHero?: Record<string, string | undefined>
  /** Scoreboard grid geometry (row Y + column X bounds) + the image's natural
   *  pixel size, so cell boxes can be expressed as fractions. */
  grid?: ScoreboardGrid
  imageNaturalWidth?: number
  imageNaturalHeight?: number
  /** Monotonic counter of matches logged this season — drives summary sampling.
   *  When omitted, sampling falls back to a hash of matchId. */
  matchSequence?: number
}

// ── Helpers ──────────────────────────────────────────────────

function positionalLabel(
  stats: ScoreboardPlayerStats[] | undefined,
  slot: number,
): string {
  const s = stats?.find(p => p.slot === slot)
  if (!s) return `Slot ${slot}`
  const teamWord = s.team === 'ally' ? 'Ally' : 'Enemy'
  const roleWord = s.role ? s.role.toUpperCase() : '?'
  const hero = s.heroName ? ` (${s.heroName})` : ''
  return `${teamWord} ${roleWord}${hero}`
}

const FIELD_DISPLAY: Record<SbCellConfidence['field'], string> = {
  eliminations: 'Eliminations',
  assists: 'Assists',
  deaths: 'Deaths',
  damage: 'Damage',
  healing: 'Healing',
  mitigation: 'Mitigation',
}

// Map a stats field to its grid column key.
const FIELD_TO_COLUMN: Record<SbCellConfidence['field'], 'E' | 'A' | 'D' | 'DMG' | 'H' | 'MIT'> = {
  eliminations: 'E',
  assists: 'A',
  deaths: 'D',
  damage: 'DMG',
  healing: 'H',
  mitigation: 'MIT',
}

/** Build a fractional highlight box for a scoreboard cell from the grid. */
function scoreboardCellRegion(
  inp: ConfirmInputs,
  slot: number,
  field: SbCellConfidence['field'],
): HighlightRegion | null {
  if (!inp.scoreboardImageUrl) return null
  if (!inp.grid || !inp.imageNaturalWidth || !inp.imageNaturalHeight) {
    // No geometry — still show the screenshot, just without a box.
    return { imageUrl: inp.scoreboardImageUrl }
  }
  const row = inp.grid.rows.find(r => r.slot === slot)
  const col = inp.grid.columns[FIELD_TO_COLUMN[field]]
  if (!row || !col) return { imageUrl: inp.scoreboardImageUrl }

  const W = inp.imageNaturalWidth
  const H = inp.imageNaturalHeight
  // Pad the box slightly so the cell isn't clipped tight.
  const padX = (col.endX - col.startX) * 0.1
  const padY = (row.bottomY - row.topY) * 0.15
  const x = Math.max(0, col.startX - padX)
  const y = Math.max(0, row.topY - padY)
  const w = Math.min(W - x, (col.endX - col.startX) + padX * 2)
  const h = Math.min(H - y, (row.bottomY - row.topY) + padY * 2)
  return {
    imageUrl: inp.scoreboardImageUrl,
    box: { x: x / W, y: y / H, w: w / W, h: h / H },
  }
}

function numericValue(v: string): number | null {
  const n = parseInt(v.replace(/[^\d-]/g, ''), 10)
  return isNaN(n) ? null : n
}

// ── Per-tier candidate producers ─────────────────────────────

function unrecognizedCandidates(inp: ConfirmInputs): ConfirmationCandidate[] {
  const out: ConfirmationCandidate[] = []

  // Breakdown UNKNOWN tiles (matchStatLabel failed AND coordinate fallback failed).
  for (const bd of inp.breakdowns ?? []) {
    for (const st of bd.stats) {
      if (st.statName.startsWith('UNKNOWN')) {
        out.push({
          id: `unknown_stat:${bd.heroName}:${st.statName}`,
          field: 'breakdown_stat',
          fieldDetail: `${bd.heroName} — unrecognized stat (${st.statName})`,
          signal: 'unrecognized',
          tier: 1,
          region: inp.breakdownImageUrlByHero?.[bd.heroName]
            ? { imageUrl: inp.breakdownImageUrlByHero[bd.heroName]! }
            : null,
          extractedValue: st.statValue,
          note: 'Stat label did not match catalog — possible new/renamed stat.',
        })
      }
    }
  }

  // Map / mode not in the reference lists (likely new content).
  if (inp.summary?.mapName && inp.knownMaps && inp.knownMaps.length > 0) {
    const m = inp.summary.mapName.trim().toLowerCase()
    const known = inp.knownMaps.some(k => k.trim().toLowerCase() === m)
    if (!known) {
      out.push({
        id: `unknown_map:${inp.summary.mapName}`,
        field: 'summary',
        fieldDetail: `Unrecognized map`,
        signal: 'unrecognized',
        tier: 1,
        region: inp.summaryImageUrl ? { imageUrl: inp.summaryImageUrl } : null,
        extractedValue: inp.summary.mapName,
        note: 'Map not in reference list — possible new map or a misread.',
      })
    }
  }
  const mode = inp.summary?.raw?.gameMode
  if (mode && inp.knownModes && inp.knownModes.length > 0) {
    const known = inp.knownModes.some(k => k.trim().toLowerCase() === mode.trim().toLowerCase())
    if (!known) {
      out.push({
        id: `unknown_mode:${mode}`,
        field: 'summary',
        fieldDetail: `Unrecognized game mode`,
        signal: 'unrecognized',
        tier: 1,
        region: inp.summaryImageUrl ? { imageUrl: inp.summaryImageUrl } : null,
        extractedValue: mode,
        note: 'Mode not in reference list — possible new mode or a misread.',
      })
    }
  }

  return out
}

function scoreboardVoteSplitCandidates(inp: ConfirmInputs): ConfirmationCandidate[] {
  const out: ConfirmationCandidate[] = []
  for (const cell of inp.scoreboardCells ?? []) {
    if (!cell.voteSplit) continue
    out.push({
      id: `scoreboard:slot${cell.slot}:${cell.field}`,
      field: 'scoreboard',
      fieldDetail: `${positionalLabel(inp.scoreboardStats, cell.slot)} — ${FIELD_DISPLAY[cell.field]}`,
      signal: 'vote_split',
      tier: 2,
      region: scoreboardCellRegion(inp, cell.slot, cell.field),
      extractedValue: cell.value === null ? '—' : String(cell.value),
      confidence: cell.confidence,
      note: 'Multi-threshold reads disagreed; majority vote applied.',
    })
  }
  return out
}

function avgCrossCheckCandidates(inp: ConfirmInputs, cfg: BetaConfirmConfig): ConfirmationCandidate[] {
  const out: ConfirmationCandidate[] = []
  for (const bd of inp.breakdowns ?? []) {
    const playtime = bd.playTimeSeconds
    if (playtime === null || playtime < cfg.avgMinPlaytimeSeconds) continue
    for (const st of bd.stats) {
      if (st.statName.startsWith('UNKNOWN')) continue   // handled by tier 1
      if (st.avgPer10Min === null) continue
      const value = numericValue(st.statValue)
      const avg = numericValue(st.avgPer10Min)
      if (value === null || avg === null || avg === 0) continue

      const expected = avg * (playtime / 600)
      if (expected === 0) continue
      const deviation = Math.abs(value - expected) / Math.max(expected, 1)
      if (deviation > cfg.avgTolerance) {
        out.push({
          id: `avgcheck:${bd.heroName}:${st.statName}`,
          field: 'breakdown_stat',
          fieldDetail: `${bd.heroName} — ${st.statName}`,
          signal: 'avg_crosscheck_fail',
          tier: 2,
          region: inp.breakdownImageUrlByHero?.[bd.heroName]
            ? { imageUrl: inp.breakdownImageUrlByHero[bd.heroName]! }
            : null,
          extractedValue: st.statValue,
          note: `Value ${value} vs expected ≈${expected.toFixed(0)} ` +
            `(avg/10min ${avg} × ${(playtime / 60).toFixed(1)}min). ` +
            `Off by ${(deviation * 100).toFixed(0)}%.`,
        })
      }
    }
  }
  return out
}

/** Highlight box around a slot's portrait column (for hero-id questions). */
function scoreboardPortraitRegion(inp: ConfirmInputs, slot: number): HighlightRegion | null {
  if (!inp.scoreboardImageUrl) return null
  if (!inp.grid || !inp.imageNaturalWidth || !inp.imageNaturalHeight) {
    return { imageUrl: inp.scoreboardImageUrl }
  }
  const row = inp.grid.rows.find(r => r.slot === slot)
  const col = inp.grid.columns.portrait
  if (!row || !col) return { imageUrl: inp.scoreboardImageUrl }
  const W = inp.imageNaturalWidth, H = inp.imageNaturalHeight
  const x = Math.max(0, col.startX)
  const y = Math.max(0, row.topY)
  const w = Math.min(W - x, col.endX - col.startX)
  const h = Math.min(H - y, row.bottomY - row.topY)
  return { imageUrl: inp.scoreboardImageUrl, box: { x: x / W, y: y / H, w: w / W, h: h / H } }
}

function heroIdCandidates(inp: ConfirmInputs): ConfirmationCandidate[] {
  const out: ConfirmationCandidate[] = []
  const seen = new Set<number>()

  for (const slot of inp.lowConfHeroSlots ?? []) {
    seen.add(slot)
    out.push({
      id: `hero:slot${slot}:lowconf`,
      field: 'hero_id',
      fieldDetail: `${positionalLabel(inp.scoreboardStats, slot)} — hero identity`,
      signal: 'low_hero_conf',
      tier: 3,
      region: scoreboardPortraitRegion(inp, slot),
      extractedValue: inp.scoreboardStats?.find(p => p.slot === slot)?.heroName ?? '?',
      note: 'Portrait match scored below the confidence gate.',
    })
  }
  for (const slot of inp.phaseDisagreementSlots ?? []) {
    if (seen.has(slot)) continue   // don't double-ask the same slot
    out.push({
      id: `hero:slot${slot}:phasedisagree`,
      field: 'hero_id',
      fieldDetail: `${positionalLabel(inp.scoreboardStats, slot)} — hero identity`,
      signal: 'phase_disagreement',
      tier: 3,
      region: scoreboardPortraitRegion(inp, slot),
      extractedValue: inp.scoreboardStats?.find(p => p.slot === slot)?.heroName ?? '?',
      note: 'Phase-1 and Pass-1 hero identification disagreed.',
    })
  }
  return out
}

function userMarginCandidate(inp: ConfirmInputs): ConfirmationCandidate[] {
  const ua = inp.userAnalysis
  if (!ua) return []
  // analyzeUserIdentity already shows its own confirmation when !resolved.
  // Here we only add a tier-3 candidate when it auto-resolved but on a NARROW
  // margin — a soft double-check the existing flow wouldn't surface.
  if (!ua.resolved) return []
  if (ua.bestCandidate.margin >= 0.30) return []
  const slot = ua.bestCandidate.slot
  const cand = ua.candidates.find(c => c.slot === slot)
  return [{
    id: `username:slot${slot}:lowmargin`,
    field: 'username',
    fieldDetail: `Your row (slot ${slot})`,
    signal: 'low_user_margin',
    tier: 3,
    region: cand?.gamertagCropUrl ? { imageUrl: cand.gamertagCropUrl } : null,
    extractedValue: cand?.heroName ? `${cand.heroName} row` : `slot ${slot}`,
    confidence: ua.bestCandidate.similarity,
    margin: ua.bestCandidate.margin,
    note: 'User row auto-resolved but the margin over the runner-up was narrow.',
  }]
}

// Rotating summary field for the sampled spot-check.
const SUMMARY_ROTATION: Array<{
  key: 'mapName' | 'result' | 'score' | 'gameLengthText'
  label: string
}> = [
  { key: 'mapName', label: 'Map' },
  { key: 'result', label: 'Result' },
  { key: 'score', label: 'Score' },
  { key: 'gameLengthText', label: 'Game length' },
]

function hashStringToInt(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

// When a match has NO flagged issues, we still show exactly ONE question — a
// randomised spot-check — so every match gets one human glance. The field is
// chosen pseudo-randomly per match (seeded by matchId or matchSequence) and
// rotates across summary fields + a random scoreboard cell.
function randomCleanCheck(inp: ConfirmInputs): ConfirmationCandidate | null {
  const seed = inp.matchSequence ?? hashStringToInt(inp.matchId)

  // Candidate pool: summary fields present + scoreboard cells present.
  const pool: ConfirmationCandidate[] = []

  if (inp.summary) {
    for (const r of SUMMARY_ROTATION) {
      const raw = inp.summary[r.key]
      if (raw !== null && raw !== undefined && raw !== '') {
        pool.push({
          id: `summary_sample:${r.key}`,
          field: 'summary',
          fieldDetail: r.label,
          signal: 'sampled_summary',
          tier: 4,
          region: inp.summaryImageUrl ? { imageUrl: inp.summaryImageUrl } : null,
          extractedValue: String(raw),
          note: 'Routine spot-check (random).',
        })
      }
    }
  }

  // A random scoreboard cell, if we have any with a real value.
  const cells = (inp.scoreboardCells ?? []).filter(c => c.value !== null)
  if (cells.length > 0) {
    const c = cells[seed % cells.length]
    pool.push({
      id: `summary_sample:scoreboard:slot${c.slot}:${c.field}`,
      field: 'scoreboard',
      fieldDetail: `${positionalLabel(inp.scoreboardStats, c.slot)} — ${FIELD_DISPLAY[c.field]}`,
      signal: 'sampled_summary',
      tier: 4,
      region: scoreboardCellRegion(inp, c.slot, c.field),
      extractedValue: String(c.value),
      note: 'Routine spot-check (random).',
    })
  }

  if (pool.length === 0) return null
  return pool[seed % pool.length]
}

// ── Ranker ───────────────────────────────────────────────────

/** Within-tier ordering: lower confidence first (more suspect surfaces sooner). */
function withinTierSort(a: ConfirmationCandidate, b: ConfirmationCandidate): number {
  const ca = a.confidence ?? 1
  const cb = b.confidence ?? 1
  return ca - cb
}

/**
 * Build the full candidate set, rank by tier, and return what to ask.
 *
 * Rule (per the 6f beta design):
 *  - If the pipeline flagged real issues, return them ranked by tier, capped at
 *    maxQuestions.
 *  - If NOTHING was flagged (a clean match), return exactly ONE randomised
 *    spot-check so every match still gets one human glance.
 */
export function buildConfirmationQuestions(
  inp: ConfirmInputs,
  cfg: BetaConfirmConfig = DEFAULT_CONFIG,
): ConfirmationCandidate[] {
  const priority: ConfirmationCandidate[] = [
    ...unrecognizedCandidates(inp),
    ...scoreboardVoteSplitCandidates(inp),
    ...avgCrossCheckCandidates(inp, cfg),
    ...heroIdCandidates(inp),
    ...userMarginCandidate(inp),
  ]

  if (priority.length > 0) {
    // Stable sort: by tier, then by suspicion within tier.
    priority.sort((a, b) => (a.tier - b.tier) || withinTierSort(a, b))
    return priority.slice(0, cfg.maxQuestions)
  }

  // Clean match → exactly one random spot-check.
  const clean = randomCleanCheck(inp)
  return clean ? [clean] : []
}
