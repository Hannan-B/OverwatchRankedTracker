// ============================================================
// IMAGE PROCESSOR — Orchestrates the full processing pipeline
// Auto-detects summary vs breakdown vs scoreboard pages
// Portrait matcher identifies heroes on summary page
// Assignment by elimination for breakdown pages
// Catalog-driven stat extraction for breakdowns
// Full scoreboard extraction pipeline for TEAMS tab
// ============================================================

import { initOpenCV, isOpenCVReady } from './opencv-loader'
import { preloadHeroBank, matchHero } from './hero-matcher'
import { ocrSummaryPage, terminateOcr, type SummaryOcrResult } from './ocr-extractor'
import {
  ocrBreakdownPage,
  terminateBreakdownOcr,
  getBreakdownPortraitLocation,
  type BreakdownOcrResult,
  type BreakdownStat,
} from './breakdown-ocr'
import {
  detectScoreboard,
  classifyRoles,
  identifyHeroes,
  analyzeUserIdentity,
  identifyUserByHeroMatch,
  buildPlayerLabels,
  extractStats,
  terminateScoreboardOcr,
  type SbCellConfidence,
} from './scoreboard-extractor'
import type { RoleType } from '@/lib/types'
import type {
  ScoreboardDetectionResult,
  ScoreboardHeroIdentification,
  ScoreboardPlayerLabel,
  ScoreboardOcrAnalysis,
  ScoreboardRoleClassification,
  ScoreboardPlayerStats,
} from '@/lib/types'
import Tesseract from 'tesseract.js'

// ============================================================
// FIXED-COORDINATE CONSTANTS (measured from 3840x2160 screenshots)
// ============================================================
// All values below were measured directly from the uploaded PS5 screenshots
// (6v6: Test_3/5/9; 5v5: Test_1/4/6) and verified across every page in both
// formats. See pixel_audit_6aiii_MEASURED.md for the full derivation.
//
// Guiding principle: UI elements sit at FIXED pixel locations. We locate
// portraits and tabs by these fixed coordinates, never by detecting the
// orange play-time ring (whose arc length varies with how long a hero was
// played — a 30-second hero is a tiny sliver and cannot be located by it).

// Native resolution these coordinates are defined in.
const NATIVE_W = 3840
const NATIVE_H = 2160

// --- Page classification: active nav-tab fill boxes ---
// The active tab (SUMMARY on summary pages, PERSONAL on breakdown pages) has a
// bright-blue fill. These two boxes never both contain fill: one is always ~0.
// Measured: summary pages -> SUMMARY box ~15812 fill px, PERSONAL box 0.
//           breakdown pages -> PERSONAL box ~11915 fill px, SUMMARY box 0.
const SUMMARY_TAB_BOX = { x0: 200, x1: 460, y0: 50, y1: 120 }
const PERSONAL_TAB_BOX = { x0: 680, x1: 880, y0: 50, y1: 120 }
// Minimum fill-pixel count to consider a tab "active". Real minimum seen is
// ~11900; empty side is exactly 0. 1000 is a wide safety margin.
const TAB_FILL_MIN = 1000

// --- Summary page: 3 fixed portrait-circle centers ---
// Y-centers do NOT change with hero count (a 1- or 2-hero match leaves the
// lower slot(s) as empty black discs). Center-x is constant at 355.
const SUMMARY_PORTRAIT_CENTERS = [
  { x: 355, y: 720 },
  { x: 355, y: 1200 },
  { x: 355, y: 1680 },
]
// Half-size of the square portrait art crop. Art inner radius ~99px; orange
// ring at r102-118. 95 stays safely inside the art. Same value used for
// breakdown portraits (PORTRAIT_ART_HALF lives in breakdown-ocr.ts too).
const SUMMARY_PORTRAIT_HALF = 95
// Empty-slot test: count orange ring-band pixels at the fixed center. A filled
// slot has >=~1491 (smallest real arc seen); an empty slot has exactly 0.
const RING_BAND_MIN_R = 95
const RING_BAND_MAX_R = 130
const SLOT_FILLED_MIN_RING_PX = 300 // >= this => filled; below => empty slot

// ============================================================
// FIXED-COORDINATE PIXEL HELPERS
// ============================================================

/** Draw an image to a canvas once and return its RGBA pixel data. */
function getImagePixels(img: HTMLImageElement): {
  data: Uint8ClampedArray
  width: number
  height: number
} {
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { data, width: canvas.width, height: canvas.height }
}

/**
 * Crop a fixed RGBA box out of full-image pixel data into the flat
 * { data, width, height } shape matchHero() expects (RGBA, 4 bytes/px).
 * Coordinates are clamped to the image bounds.
 */
function cropRGBA(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  x: number,
  y: number,
  w: number,
  h: number,
): { data: number[]; width: number; height: number } {
  const out = new Array<number>(w * h * 4)
  let o = 0
  for (let yy = 0; yy < h; yy++) {
    const sy = Math.min(srcH - 1, Math.max(0, y + yy))
    for (let xx = 0; xx < w; xx++) {
      const sx = Math.min(srcW - 1, Math.max(0, x + xx))
      const si = (sy * srcW + sx) * 4
      out[o++] = src[si]
      out[o++] = src[si + 1]
      out[o++] = src[si + 2]
      out[o++] = src[si + 3]
    }
  }
  return { data: out, width: w, height: h }
}

/**
 * Count orange ring-band pixels around a fixed center, used ONLY to decide
 * whether a summary portrait slot is filled or empty (an empty slot is a
 * near-black disc with no ring). This does not locate anything — the center
 * is already fixed; it just checks presence. Orange test and band radii are
 * the measured values.
 */
function countRingBandPixels(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  cx: number,
  cy: number,
): number {
  let count = 0
  const rMinSq = RING_BAND_MIN_R * RING_BAND_MIN_R
  const rMaxSq = RING_BAND_MAX_R * RING_BAND_MAX_R
  for (let yy = -RING_BAND_MAX_R; yy <= RING_BAND_MAX_R; yy++) {
    const py = cy + yy
    if (py < 0 || py >= srcH) continue
    for (let xx = -RING_BAND_MAX_R; xx <= RING_BAND_MAX_R; xx++) {
      const dsq = xx * xx + yy * yy
      if (dsq < rMinSq || dsq > rMaxSq) continue
      const px = cx + xx
      if (px < 0 || px >= srcW) continue
      const si = (py * srcW + px) * 4
      const r = src[si], g = src[si + 1], b = src[si + 2]
      // measured orange-ring test
      if (r > 190 && g >= 60 && g <= 175 && b < 95 && r - b > 110) count++
    }
  }
  return count
}

// ============================================================
// PAGE TYPE DETECTION
// ============================================================

type PageType = 'summary' | 'breakdown' | 'scoreboard' | 'unknown'

let classifyWorker: Tesseract.Worker | null = null

async function getClassifyWorker(): Promise<Tesseract.Worker> {
  if (!classifyWorker) {
    classifyWorker = await Tesseract.createWorker('eng')
  }
  return classifyWorker
}

const SUMMARY_KEYWORDS = ['TOTAL PERFORMANCE', 'FINAL SCORE', 'GAME LENGTH']
const BREAKDOWN_KEYWORDS = ['PERCENT PLAYED', 'PLAY TIME']

/**
 * Classify a page image.
 * Tries pixel-based scoreboard detection first (fast, no OCR).
 * Falls through to OCR keyword matching for summary/breakdown.
 */
async function classifyImage(img: HTMLImageElement): Promise<{
  pageType: PageType
  scoreboardDetection: ScoreboardDetectionResult | null
}> {
  // Step 1 (fast, no OCR): pixel-based scoreboard detection.
  const sbDetection = await detectScoreboard(img)
  if (sbDetection.imageType === 'scoreboard') {
    console.log('Page classification: scoreboard (pixel detection)')
    return { pageType: 'scoreboard', scoreboardDetection: sbDetection }
  }

  // Step 2 (fast, no OCR): summary vs breakdown via the active nav-tab fill.
  // The active tab's bright-blue fill sits in one of two fixed, non-overlapping
  // boxes. This replaces the old full-page Tesseract keyword scan.
  const { data, width, height } = getImagePixels(img)
  const summaryFill = countTabFill(data, width, height, SUMMARY_TAB_BOX)
  const personalFill = countTabFill(data, width, height, PERSONAL_TAB_BOX)
  console.log(`Page classification (tab fill): summary=${summaryFill}, personal=${personalFill}`)

  if (summaryFill >= TAB_FILL_MIN && summaryFill > personalFill) {
    return { pageType: 'summary', scoreboardDetection: null }
  }
  if (personalFill >= TAB_FILL_MIN && personalFill > summaryFill) {
    return { pageType: 'breakdown', scoreboardDetection: null }
  }

  // Step 3 (last resort): if neither tab box read as active (unexpected crop,
  // overlay, or future UI change), fall back to the old OCR keyword scan so we
  // degrade gracefully rather than returning 'unknown'.
  console.warn('Tab-fill classification inconclusive; falling back to OCR keyword scan')
  const worker = await getClassifyWorker()
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  canvas.getContext('2d')!.drawImage(img, 0, 0)

  const { data: ocr } = await worker.recognize(canvas)
  const text = ocr.text.toUpperCase()

  let summaryScore = 0
  let breakdownScore = 0
  for (const kw of SUMMARY_KEYWORDS) if (text.includes(kw)) summaryScore++
  for (const kw of BREAKDOWN_KEYWORDS) if (text.includes(kw)) breakdownScore++

  console.log(`Page classification (OCR fallback): summary=${summaryScore}, breakdown=${breakdownScore}`)

  if (summaryScore >= 2 && summaryScore > breakdownScore) return { pageType: 'summary', scoreboardDetection: null }
  if (breakdownScore >= 1 && breakdownScore >= summaryScore) return { pageType: 'breakdown', scoreboardDetection: null }
  if (summaryScore >= 1) return { pageType: 'summary', scoreboardDetection: null }
  if (breakdownScore >= 1) return { pageType: 'breakdown', scoreboardDetection: null }

  return { pageType: 'unknown', scoreboardDetection: null }
}

// ============================================================
// EXPORTED CLASSIFICATION HELPERS (for grouping callers)
// ------------------------------------------------------------
// These let the testing page (and the production upload page) group an
// arbitrary pile of screenshots into matches BEFORE processing, using the
// EXACT same page classifier the pipeline uses internally. This is what
// makes content-based grouping safe for phone uploads whose filenames carry
// no semantic info (IMG_1898, IMG_1899, ...): we never trust the filename to
// decide what a page is — we look at the pixels.
// ============================================================

export type { PageType }

/**
 * Classify a single already-loaded image into 'summary' | 'breakdown' |
 * 'scoreboard' | 'unknown'. Thin wrapper over the internal classifier so
 * callers share one source of truth (no drift between grouping and the
 * pipeline's own bucketing).
 */
export async function classifyPageType(img: HTMLImageElement): Promise<PageType> {
  const { pageType } = await classifyImage(img)
  return pageType
}

/** Canonical within-match processing order: summary first, then breakdown(s), then scoreboard. */
const PAGE_ORDER: Record<PageType, number> = {
  summary: 0,
  breakdown: 1,
  scoreboard: 2,
  unknown: 3,
}

/** A photo paired with its classified page type, used for ordering/grouping. */
export interface ClassifiedPhoto<T> {
  item: T
  pageType: PageType
}

/**
 * Sort a set of classified photos into canonical order:
 *   Summary → Breakdown(s) → Scoreboard → (unknown last)
 * Ties within a page type preserve the caller's original order (stable),
 * so multiple breakdown pages keep their capture/filename sequence.
 *
 * The pipeline buckets by type internally, so it is order-insensitive — but
 * ordering here makes the logs, the test report, and the production review
 * screen read in the order the user asked for, and makes content-based
 * grouping deterministic.
 */
export function orderByPageType<T>(photos: ClassifiedPhoto<T>[]): ClassifiedPhoto<T>[] {
  return photos
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const d = PAGE_ORDER[a.p.pageType] - PAGE_ORDER[b.p.pageType]
      return d !== 0 ? d : a.i - b.i
    })
    .map(({ p }) => p)
}

/**
 * Group an ordered (by capture/filename) sequence of classified photos into
 * matches using PAGE CONTENT, not filenames. This is the phone-upload path.
 *
 * Cut rule: each match owns exactly one summary page, so a summary page
 * starts a new match. Breakdown and scoreboard pages attach to the current
 * match. A scoreboard also closes the current match (a new page after it
 * begins a fresh group even if no summary appeared yet), which keeps two
 * back-to-back matches from merging when a summary is missing.
 *
 * Leading pages with no summary yet (e.g. a stray breakdown uploaded first)
 * start their own group rather than being dropped. Each returned group is
 * re-sorted into canonical order via orderByPageType().
 */
export function groupPhotosByContent<T>(
  photosInCaptureOrder: ClassifiedPhoto<T>[],
): ClassifiedPhoto<T>[][] {
  const groups: ClassifiedPhoto<T>[][] = []
  let current: ClassifiedPhoto<T>[] = []
  let currentHasScoreboard = false

  const flush = () => {
    if (current.length > 0) {
      groups.push(orderByPageType(current))
      current = []
      currentHasScoreboard = false
    }
  }

  for (const photo of photosInCaptureOrder) {
    const startsNewMatch =
      // a summary always begins a new match
      photo.pageType === 'summary' ||
      // anything arriving after we've already seen this match's scoreboard
      // belongs to the next match
      currentHasScoreboard
    if (startsNewMatch) flush()

    current.push(photo)
    if (photo.pageType === 'scoreboard') currentHasScoreboard = true
  }
  flush()

  return groups
}

/**
 * Count active-tab fill pixels inside a fixed box. The active nav tab's fill is
 * a bright blue: blue>90, blue-red>55, green>=red, blue>green (measured).
 */
function countTabFill(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  box: { x0: number; x1: number; y0: number; y1: number },
): number {
  let count = 0
  for (let y = box.y0; y <= box.y1 && y < srcH; y++) {
    for (let x = box.x0; x <= box.x1 && x < srcW; x++) {
      const si = (y * srcW + x) * 4
      const r = src[si], g = src[si + 1], b = src[si + 2]
      if (b > 90 && b - r > 55 && g >= r && b > g) count++
    }
  }
  return count
}

async function terminateClassifyWorker() {
  if (classifyWorker) {
    await classifyWorker.terminate()
    classifyWorker = null
  }
}

// ============================================================
// TYPES
// ============================================================

export interface HeroBreakdownResult {
  heroName: string
  percentPlayed: number | null
  playTimeSeconds: number | null
  stats: BreakdownStat[]
  expectedStatCount: number
  foundStatCount: number
  matchedToSummary: boolean
  /** 6f: source image URL of this breakdown photo (for confirmation display). */
  imageUrl?: string
}

/** Scoreboard extraction results (10 or 12 player data from TEAMS tab) */
export interface ScoreboardResult {
  detection: ScoreboardDetectionResult
  heroes: ScoreboardHeroIdentification[]
  roles: ScoreboardRoleClassification[]
  players: ScoreboardPlayerLabel[]
  stats: ScoreboardPlayerStats[]
  ocrAnalysis: ScoreboardOcrAnalysis
  /** 6f: per-cell scoreboard confidence + vote-split flags (for beta confirmation). */
  cellConfidence?: SbCellConfidence[]
  /** 6f: source image URL of the scoreboard photo (for confirmation highlights). */
  imageUrl?: string
}

export interface ProcessedMatch {
  mapName: string | null
  result: 'victory' | 'defeat' | 'draw' | null
  score: string | null
  gameLengthSeconds: number | null
  /** Real match time OCR'd from the summary screenshot; null if unreadable. */
  matchTimestamp: Date | null
  eliminations: number | null
  assists: number | null
  deaths: number | null
  heroes: {
    name: string
    confidence: number
    source: 'image' | 'ocr' | 'both'
  }[]
  heroBreakdowns: HeroBreakdownResult[]
  correctedRole: RoleType | null
  ocrRaw: Record<string, string>
  scoreboard: ScoreboardResult | null
  allyComp: string | null
  enemyComp: string | null
  /** Detected match format from scoreboard pixel analysis ('5v5' or '6v6') */
  matchFormat: '5v5' | '6v6' | null
  /** 6f: source image URL of the summary photo (for confirmation display). */
  summaryImageUrl?: string
  processingTimeMs: number
}

export type ProcessingStatus =
  | { stage: 'loading_opencv'; progress: 0 }
  | { stage: 'loading_heroes'; progress: 10 }
  | { stage: 'processing_photo'; progress: number; photoIndex: number; total: number }
  | { stage: 'classifying_pages'; progress: number }
  | { stage: 'running_ocr'; progress: number }
  | { stage: 'matching_heroes'; progress: number }
  | { stage: 'reading_breakdowns'; progress: number }
  | { stage: 'reading_scoreboard'; progress: number }
  | { stage: 'complete'; progress: 100 }

// ============================================================
// RESULT FROM SCORE
// ============================================================

function resultFromScore(score: string | null): 'victory' | 'defeat' | 'draw' | null {
  if (!score) return null
  const match = score.match(/^(\d+)-(\d+)$/)
  if (!match) return null
  const playerScore = parseInt(match[1])
  const opponentScore = parseInt(match[2])
  if (playerScore > opponentScore) return 'victory'
  if (playerScore < opponentScore) return 'defeat'
  return 'draw'
}

// ============================================================
// ASSIGNMENT BY ELIMINATION
// Matches breakdown images to known heroes optimally.
// Each image gets scored against all candidate heroes,
// then assigned greedily: highest-confidence pair first.
// ============================================================

interface BreakdownAssignment {
  imageIndex: number
  heroName: string
  score: number
}

async function assignBreakdownsToHeroes(
  breakdownImages: HTMLImageElement[],
  knownHeroNames: string[],
  opencvAvailable: boolean,
): Promise<BreakdownAssignment[]> {
  if (!opencvAvailable || breakdownImages.length === 0 || knownHeroNames.length === 0) {
    return []
  }

  console.log(`Assignment by elimination: ${breakdownImages.length} images × ${knownHeroNames.length} heroes`)

  // Score each image's portrait against each known hero individually.
  // This builds the full matrix used for greedy assignment.
  const fullScoreMatrix: { imageIndex: number; heroName: string; score: number }[] = []

  for (let i = 0; i < breakdownImages.length; i++) {
    // Crop the R1C1 hero portrait at its FIXED location (variant-aware center
    // from breakdown-ocr.ts, the single source of truth for the grid layout).
    // This replaces OpenCV detectPortraits, which previously had to *find* the
    // portrait and could fail or drift; the location is fixed, so we just crop.
    const { data, width, height } = getImagePixels(breakdownImages[i])
    const loc = getBreakdownPortraitLocation(breakdownImages[i])
    const portrait = cropRGBA(
      data, width, height,
      loc.cropBox.x, loc.cropBox.y, loc.cropBox.w, loc.cropBox.h,
    )
    console.log(`Breakdown ${i + 1}: variant ${loc.variant}, portrait center (${loc.centerX},${loc.centerY})`)

    // Score this fixed-crop portrait against each known hero.
    for (const heroName of knownHeroNames) {
      const result = await matchHero(portrait, true, undefined, [heroName])
      fullScoreMatrix.push({
        imageIndex: i,
        heroName,
        score: result.score,
      })
    }

    console.log(`Breakdown ${i + 1} scores: ${knownHeroNames.map(h => {
      const s = fullScoreMatrix.find(m => m.imageIndex === i && m.heroName === h)
      return `${h}=${s?.score.toFixed(4) || '?'}`
    }).join(', ')}`)
  }

  // Greedy assignment: pick highest-confidence pair, assign, remove both, repeat.
  // (Confirmed adequate for the 1-3 hero case, which is all that can appear on
  // the summary shortlist. The >3 case is handled separately by the caller.)
  const assignments: BreakdownAssignment[] = []
  const assignedImages = new Set<number>()
  const assignedHeroes = new Set<string>()

  // Sort by score descending
  const sorted = [...fullScoreMatrix].sort((a, b) => b.score - a.score)

  for (const entry of sorted) {
    if (assignedImages.has(entry.imageIndex)) continue
    if (assignedHeroes.has(entry.heroName)) continue

    assignments.push(entry)
    assignedImages.add(entry.imageIndex)
    assignedHeroes.add(entry.heroName)

    console.log(`Assigned: image ${entry.imageIndex + 1} → ${entry.heroName} (score: ${entry.score.toFixed(4)})`)

    // Stop when all images or all heroes are assigned
    if (assignedImages.size === breakdownImages.length) break
    if (assignedHeroes.size === knownHeroNames.length) break
  }

  return assignments
}

// ============================================================
// MAIN PIPELINE
// ============================================================

export async function processMatchPhotos(
  photoUrls: string[],
  onStatus: (status: ProcessingStatus) => void,
  roleFilter?: RoleType,
  gamertag?: string,
): Promise<ProcessedMatch> {
  const startTime = Date.now()

  const result: ProcessedMatch = {
    mapName: null, result: null, score: null,
    gameLengthSeconds: null, matchTimestamp: null, eliminations: null,
    assists: null, deaths: null, heroes: [],
    heroBreakdowns: [],
    correctedRole: null,
    ocrRaw: {},
    scoreboard: null,
    allyComp: null,
    enemyComp: null,
    matchFormat: null,
    processingTimeMs: 0,
  }

  // Step 1: Initialize OpenCV
  onStatus({ stage: 'loading_opencv', progress: 0 })
  let opencvAvailable = false
  try {
    opencvAvailable = await initOpenCV()
  } catch (e) {
    console.warn('OpenCV Worker failed:', e)
  }

  // Step 2: Load hero bank
  onStatus({ stage: 'loading_heroes', progress: 10 })
  await preloadHeroBank()
  if (roleFilter) console.log(`Role filter active: ${roleFilter}`)

  // Step 3: Load all photos
  const images: HTMLImageElement[] = []
  for (let i = 0; i < photoUrls.length; i++) {
    onStatus({
      stage: 'processing_photo',
      progress: 15 + (i / photoUrls.length) * 10,
      photoIndex: i,
      total: photoUrls.length,
    })
    try {
      images.push(await loadImage(photoUrls[i]))
    } catch (e) {
      console.warn(`Failed to load photo ${i}:`, e)
    }
  }

  if (images.length === 0) {
    result.processingTimeMs = Date.now() - startTime
    onStatus({ stage: 'complete', progress: 100 })
    return result
  }

  // Step 4: Auto-detect page types (scoreboard check is pixel-based, runs first)
  onStatus({ stage: 'classifying_pages', progress: 28 })
  let summaryImage: HTMLImageElement | null = null
  const breakdownImages: HTMLImageElement[] = []
  let scoreboardImage: HTMLImageElement | null = null
  let scoreboardDetection: ScoreboardDetectionResult | null = null

  for (let i = 0; i < images.length; i++) {
    onStatus({ stage: 'classifying_pages', progress: 28 + ((i / images.length) * 10) })
    const { pageType, scoreboardDetection: sbDet } = await classifyImage(images[i])
    console.log(`Image ${i + 1}: classified as "${pageType}"`)

    if (pageType === 'scoreboard' && !scoreboardImage) {
      scoreboardImage = images[i]
      scoreboardDetection = sbDet
    } else if (pageType === 'summary' && !summaryImage) {
      summaryImage = images[i]
    } else if (pageType === 'breakdown') {
      breakdownImages.push(images[i])
    } else if (pageType === 'summary' && summaryImage) {
      // Duplicate summary → treat as breakdown
      breakdownImages.push(images[i])
    } else if (pageType === 'scoreboard' && scoreboardImage) {
      // Duplicate scoreboard → ignore
      console.warn(`Image ${i + 1}: duplicate scoreboard, ignoring`)
    } else {
      breakdownImages.push(images[i])
    }
  }

  if (!summaryImage) {
    // Fall back to first non-scoreboard image as summary
    const nonScoreboard = images.filter(img => img !== scoreboardImage)
    if (nonScoreboard.length > 0) {
      summaryImage = nonScoreboard[0]
      const idx = breakdownImages.indexOf(nonScoreboard[0])
      if (idx >= 0) breakdownImages.splice(idx, 1)
    }
  }

  await terminateClassifyWorker()
  console.log(
    `Classification: ${summaryImage ? '1 summary' : '0 summary'}, ` +
    `${breakdownImages.length} breakdown(s), ` +
    `${scoreboardImage ? '1 scoreboard' : '0 scoreboard'}`
  )

  // Step 5: Summary page OCR
  if (summaryImage) {
    result.summaryImageUrl = summaryImage.src
    onStatus({ stage: 'running_ocr', progress: 40 })
    let summaryOcr: SummaryOcrResult | null = null
    try {
      summaryOcr = await ocrSummaryPage(summaryImage)
      result.mapName = summaryOcr.mapName
      result.score = summaryOcr.score
      result.gameLengthSeconds = summaryOcr.gameLengthSeconds
      result.matchTimestamp = summaryOcr.matchTimestamp
      result.eliminations = summaryOcr.eliminations
      result.assists = summaryOcr.assists
      result.deaths = summaryOcr.deaths
      result.ocrRaw = summaryOcr.raw

      const scoreResult = resultFromScore(result.score)
      if (scoreResult) {
        result.result = scoreResult
      } else {
        result.result = summaryOcr.result
      }
    } catch (e) {
      console.warn('Summary OCR failed:', e)
    }

    // Step 6: Hero matching on summary page
    onStatus({ stage: 'matching_heroes', progress: 55 })
    const allHeroMatches = new Map<string, { score: number; source: 'image' | 'ocr' | 'both' }>()
    let detectedCorrectedRole: RoleType | null = null

    if (opencvAvailable) {
      try {
        // Crop each of the 3 FIXED summary portrait slots and match it.
        // Slots have fixed centers; their Y does not move with hero count.
        // An unplayed slot is an empty black disc (no orange ring) — detected
        // by zero ring-band pixels — and is skipped so we never match a phantom.
        const { data, width, height } = getImagePixels(summaryImage)

        for (let s = 0; s < SUMMARY_PORTRAIT_CENTERS.length; s++) {
          const { x: cx, y: cy } = SUMMARY_PORTRAIT_CENTERS[s]

          // Filled-vs-empty check at the fixed center (presence of ring), NOT
          // a way of locating the portrait — the center is already fixed.
          const ringPx = countRingBandPixels(data, width, height, cx, cy)
          if (ringPx < SLOT_FILLED_MIN_RING_PX) {
            console.log(`Summary slot ${s} @(${cx},${cy}): empty (ring px=${ringPx}) — skipped`)
            continue
          }

          const portrait = cropRGBA(
            data, width, height,
            cx - SUMMARY_PORTRAIT_HALF, cy - SUMMARY_PORTRAIT_HALF,
            SUMMARY_PORTRAIT_HALF * 2, SUMMARY_PORTRAIT_HALF * 2,
          )
          const match = await matchHero(portrait, true, roleFilter)
          console.log(`Summary slot ${s} @(${cx},${cy}): ${match.heroName} (score ${match.score.toFixed(4)}, ring px=${ringPx})`)

          // Keep the best score if the same hero somehow appears twice.
          const existing = allHeroMatches.get(match.heroName)
          if (!existing || match.score > existing.score) {
            allHeroMatches.set(match.heroName, { score: match.score, source: 'image' })
          }
          if (match.correctedRole && !detectedCorrectedRole) {
            detectedCorrectedRole = match.correctedRole
          }
        }
      } catch (e) {
        console.warn('Summary hero detection failed:', e)
      }
    }

    if (summaryOcr?.heroNames) {
      for (const ocrHero of summaryOcr.heroNames) {
        const existing = allHeroMatches.get(ocrHero)
        if (existing) existing.source = 'both'
        else allHeroMatches.set(ocrHero, { score: 0.5, source: 'ocr' })
      }
    }

    const HERO_CONFIDENCE_THRESHOLD = 0.13
    result.heroes = Array.from(allHeroMatches.entries())
      .map(([name, data]) => ({ name, confidence: data.score, source: data.source }))
      .filter(h => h.confidence >= HERO_CONFIDENCE_THRESHOLD || h.source === 'ocr')
      .sort((a, b) => b.confidence - a.confidence)

    result.correctedRole = detectedCorrectedRole
  }

  const summaryHeroNames = new Set(result.heroes.map(h => h.name))
  if (summaryHeroNames.size > 0) {
    console.log(`Summary heroes: [${Array.from(summaryHeroNames).join(', ')}]`)
  }

  // Step 7: Assignment by elimination + catalog-driven OCR for breakdowns
  if (breakdownImages.length > 0 && opencvAvailable) {
    onStatus({ stage: 'reading_breakdowns', progress: 65 })

    const knownHeroes = Array.from(summaryHeroNames)
    const assignments = await assignBreakdownsToHeroes(
      breakdownImages, knownHeroes, opencvAvailable,
    )

    for (const assignment of assignments) {
      onStatus({
        stage: 'reading_breakdowns',
        progress: 75 + ((assignments.indexOf(assignment) / assignments.length) * 20),
      })

      try {
        const breakdown = await ocrBreakdownPage(
          breakdownImages[assignment.imageIndex],
          assignment.heroName,
        )

        result.heroBreakdowns.push({
          heroName: breakdown.heroName,
          percentPlayed: breakdown.percentPlayed,
          playTimeSeconds: breakdown.playTimeSeconds,
          stats: breakdown.stats,
          expectedStatCount: breakdown.expectedStatCount,
          foundStatCount: breakdown.foundStatCount,
          matchedToSummary: true,
          imageUrl: breakdownImages[assignment.imageIndex].src,
        })
      } catch (e) {
        console.warn(`Breakdown OCR failed for ${assignment.heroName}:`, e)
      }
    }

    // Coverage check
    const breakdownHeroNames = new Set(result.heroBreakdowns.map(b => b.heroName))
    for (const hero of summaryHeroNames) {
      if (!breakdownHeroNames.has(hero)) {
        console.warn(`COVERAGE GAP: "${hero}" detected on summary but no breakdown assigned`)
      }
    }
  }

  // Step 8: Scoreboard extraction (full pipeline)
  if (scoreboardImage && scoreboardDetection) {
    onStatus({ stage: 'reading_scoreboard', progress: 88 })
    console.log('Running scoreboard extraction pipeline...')

    try {
      // Step 4→2 pipeline: roles (icon detection) → heroes (role-filtered)
      onStatus({ stage: 'reading_scoreboard', progress: 89 })
      const roles = await classifyRoles(scoreboardImage, scoreboardDetection)

      onStatus({ stage: 'reading_scoreboard', progress: 91 })
      const heroes = await identifyHeroes(scoreboardImage, scoreboardDetection, roles)

      // Compute team compositions AFTER role overrides so comps reflect actual heroes
      const computeTeamComp = (team: 'ally' | 'enemy'): string => {
        const teamRoles = roles.filter(r => r.team === team && r.role)
        const tanks = teamRoles.filter(r => r.role === 'tank').length
        const dps = teamRoles.filter(r => r.role === 'dps').length
        const support = teamRoles.filter(r => r.role === 'support').length
        return `${tanks}-${dps}-${support}`
      }
      result.allyComp = computeTeamComp('ally')
      result.enemyComp = computeTeamComp('enemy')
      result.matchFormat = scoreboardDetection.format as '5v5' | '6v6' | null
      console.log(`Team comps: Ally ${result.allyComp}, Enemy ${result.enemyComp} (format: ${result.matchFormat})`)

      // Step 3: User identification — Tier 2 hero-match first, then OCR fallback
      onStatus({ stage: 'reading_scoreboard', progress: 93 })
      const resolvedGamertag = gamertag || 'Unknown'

      // Tier 2: Check if known heroes from summary/breakdown match exactly one ally slot
      const knownUserHeroes = result.heroes.map(h => h.name)
      const heroMatchResult = identifyUserByHeroMatch(heroes, knownUserHeroes)

      let userSlot: number | null = null
      let userMethod: 'ocr_auto' | 'hero_match' | null = null
      let ocrAnalysis: ScoreboardOcrAnalysis

      if (heroMatchResult.resolved) {
        // Tier 2 resolved — skip OCR entirely
        console.log(`User ID via Tier 2 hero-match: slot ${heroMatchResult.userSlot} (${heroMatchResult.matchedHero})`)
        userSlot = heroMatchResult.userSlot
        userMethod = 'hero_match'

        // Build a synthetic ocrAnalysis so the rest of the pipeline stays consistent
        const allyHeroes = heroes.filter(h => h.team === 'ally')
        ocrAnalysis = {
          resolved: true,
          userSlot: heroMatchResult.userSlot,
          bestCandidate: { slot: heroMatchResult.userSlot!, similarity: 1.0, margin: 1.0 },
          candidates: allyHeroes.map(h => ({
            slot: h.slot,
            heroName: h.heroName,
            heroPortraitUrl: h.portraitDataUrl,
            gamertagCropUrl: null,
            ocrSimilarity: h.slot === heroMatchResult.userSlot ? 1.0 : 0,
          })),
        }
      } else {
        // Tier 2 couldn't resolve — fall through to OCR
        console.log(`Tier 2 hero-match: ${heroMatchResult.details} — trying OCR...`)
        ocrAnalysis = await analyzeUserIdentity(
          scoreboardImage, heroes, scoreboardDetection, roles, resolvedGamertag,
        )
        if (ocrAnalysis.resolved) {
          userSlot = ocrAnalysis.userSlot
          userMethod = 'ocr_auto'
        }
      }

      // Build player labels
      const players = buildPlayerLabels(
        heroes, roles, resolvedGamertag,
        userSlot,
        userMethod as any,
      )

      // Step 5: Stats extraction via template matching
      onStatus({ stage: 'reading_scoreboard', progress: 95 })
      const cellConfidence: SbCellConfidence[] = []
      const stats = await extractStats(scoreboardImage, heroes, roles, players, scoreboardDetection, cellConfidence)

      result.scoreboard = {
        detection: scoreboardDetection,
        heroes,
        roles,
        players,
        stats,
        ocrAnalysis,
        cellConfidence,
        imageUrl: scoreboardImage.src,
      }

      const totalSlots = scoreboardDetection.grid ? scoreboardDetection.grid.rowsPerTeam * 2 : 10
      console.log(
        `Scoreboard extraction complete (${scoreboardDetection.format ?? '5v5'}): ` +
        `${heroes.filter(h => h.heroName).length}/${totalSlots} heroes, ` +
        `${roles.filter(r => r.role).length}/${totalSlots} roles, ` +
        `${stats.filter(s => s.eliminations !== null).length}/${totalSlots} stats, ` +
        `user ${ocrAnalysis.resolved ? 'auto-resolved' : 'needs confirmation'}, ` +
        `comps: Ally ${result.allyComp} / Enemy ${result.enemyComp}`
      )
    } catch (e) {
      console.warn('Scoreboard extraction failed:', e)
    }
  }

  // Cleanup
  await terminateOcr()
  await terminateBreakdownOcr()
  await terminateScoreboardOcr()

  result.processingTimeMs = Date.now() - startTime
  onStatus({ stage: 'complete', progress: 100 })
  return result
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load: ${url}`))
    img.src = url
  })
}
