// ============================================================
// SCOREBOARD EXTRACTOR — Library module for scoreboard processing
// Extracted from testing/page.tsx (Steps 1–5)
//
// Pipeline order: Step 1 → Step 4 → Step 2 → Step 3 → Step 5
//   detectScoreboard  → detection + grid
//   classifyRoles     → roles[] (icon-based, no heroes needed)
//   identifyHeroes    → heroes[] (role-filtered matching)
//   analyzeUserIdentity → ocrAnalysis (may need confirmation)
//   buildPlayerLabels → players[]
//   extractStats      → stats[]
//
// All pixel coordinates calibrated for 3840×2160 (PS5 screenshots).
// ============================================================

import { loadHeroBank, matchHero, scoreCropAgainstAllHeroes } from '@/lib/hero-matcher'
import { initOpenCV } from '@/lib/opencv-loader'
import type { RoleType } from '@/lib/types'
import type {
  ScoreboardGrid,
  ScoreboardGridRow,
  ScoreboardDetectionResult,
  ScoreboardHeroIdentification,
  ScoreboardPlayerLabel,
  ScoreboardUserCandidate,
  ScoreboardOcrAnalysis,
  ScoreboardRoleClassification,
  ScoreboardPlayerStats,
} from '@/lib/types'
import Tesseract from 'tesseract.js'

// Re-export types for convenience
export type {
  ScoreboardGrid,
  ScoreboardGridRow,
  ScoreboardDetectionResult,
  ScoreboardHeroIdentification,
  ScoreboardPlayerLabel,
  ScoreboardUserCandidate,
  ScoreboardOcrAnalysis,
  ScoreboardRoleClassification,
  ScoreboardPlayerStats,
}

// Hero → Role lookup: every Overwatch hero has a fixed role.
// Used to override icon-based role classification after hero identification.
const HERO_ROLE_MAP: Record<string, RoleType> = {
  // Tanks (14)
  'D.Va': 'tank', 'Doomfist': 'tank', 'Domina': 'tank', 'Hazard': 'tank',
  'Junker Queen': 'tank', 'Mauga': 'tank', 'Orisa': 'tank', 'Ramattra': 'tank',
  'Reinhardt': 'tank', 'Roadhog': 'tank', 'Sigma': 'tank', 'Winston': 'tank',
  'Wrecking Ball': 'tank', 'Zarya': 'tank',
  // DPS (23)
  'Anran': 'dps', 'Ashe': 'dps', 'Bastion': 'dps', 'Cassidy': 'dps',
  'Echo': 'dps', 'Emre': 'dps', 'Freja': 'dps', 'Genji': 'dps',
  'Hanzo': 'dps', 'Junkrat': 'dps', 'Mei': 'dps', 'Pharah': 'dps',
  'Reaper': 'dps', 'Sierra': 'dps', 'Sojourn': 'dps', 'Soldier: 76': 'dps',
  'Sombra': 'dps', 'Symmetra': 'dps', 'Torbjörn': 'dps', 'Tracer': 'dps',
  'Vendetta': 'dps', 'Venture': 'dps', 'Widowmaker': 'dps',
  // Support (14)
  'Ana': 'support', 'Baptiste': 'support', 'Brigitte': 'support',
  'Illari': 'support', 'Jetpack Cat': 'support', 'Juno': 'support',
  'Kiriko': 'support', 'Lifeweaver': 'support', 'Lúcio': 'support',
  'Mercy': 'support', 'Mizuki': 'support', 'Moira': 'support',
  'Wuyang': 'support', 'Zenyatta': 'support',
}

/** Hero names present in the scoreboard HERO_ROLE_MAP above. Exported so the
 *  testing page's new-content readiness check can confirm a new hero was added
 *  here (one of the required New-Season steps). Read-only; do not mutate. */
export const SCOREBOARD_ROLE_HERO_NAMES: string[] = Object.keys(HERO_ROLE_MAP)

/** Override icon-detected roles with the identified hero's known role.
 *  Call after identifyHeroes() — mutates roles in place, returns override count. */
export function overrideRolesFromHeroes(
  roles: ScoreboardRoleClassification[],
  heroes: ScoreboardHeroIdentification[],
): number {
  let overrideCount = 0
  for (const role of roles) {
    const hero = heroes.find(h => h.slot === role.slot)
    role.heroName = hero?.heroName ?? null
    if (hero?.heroName && HERO_ROLE_MAP[hero.heroName]) {
      const heroRole = HERO_ROLE_MAP[hero.heroName]
      if (role.role !== heroRole) {
        console.log(`Role override: Slot ${role.slot} ${role.role} → ${heroRole} (from hero ${hero.heroName})`)
        role.role = heroRole
        role.source = 'hero_lookup'
        overrideCount++
      }
    }
  }
  return overrideCount
}

// ============================================================
// CONSTANTS — Fixed column X positions (3840×2160)
// ============================================================

const SCOREBOARD_COLUMNS: ScoreboardGrid['columns'] = {
  roleIcon:  { x: 1070 },
  portrait:  { startX: 1130, endX: 1280 },
  username:  { startX: 1290, endX: 1800 },
  E:   { startX: 1830, endX: 1920, centerX: 1875 },
  A:   { startX: 1940, endX: 2030, centerX: 1985 },
  D:   { startX: 2050, endX: 2140, centerX: 2095 },
  DMG: { startX: 2180, endX: 2350, centerX: 2265 },
  H:   { startX: 2390, endX: 2530, centerX: 2460 },
  MIT: { startX: 2580, endX: 2750, centerX: 2665 },
}

// 6v6 stat columns shift progressively leftward (up to ~60px for MIT)
// Measured from 10 × 6v6 screenshots
const SCOREBOARD_COLUMNS_6V6: ScoreboardGrid['columns'] = {
  roleIcon:  { x: 1168 },
  portrait:  { startX: 1150, endX: 1370 },
  username:  { startX: 1340, endX: 1800 },
  E:   { startX: 1830, endX: 1930, centerX: 1878 },
  A:   { startX: 1935, endX: 2035, centerX: 1985 },
  D:   { startX: 2030, endX: 2125, centerX: 2076 },
  DMG: { startX: 2150, endX: 2320, centerX: 2234 },
  H:   { startX: 2340, endX: 2510, centerX: 2423 },
  MIT: { startX: 2520, endX: 2690, centerX: 2605 },
}

function getScoreboardColumns(format: '5v5' | '6v6' | null): ScoreboardGrid['columns'] {
  return format === '6v6' ? SCOREBOARD_COLUMNS_6V6 : SCOREBOARD_COLUMNS
}

// Role icon detection bounds
const ICON_X_START = 1082
const ICON_X_END = 1109

// ── Format-specific pixel calibration ──
// 5v5 and 6v6 scoreboards have different X positions for icons, portraits, and gamertags.
// Stat columns (E through H) are identical; MIT shifts ~30px left in 6v6.
// Format is detected via VS gap height: ≤175px → 6v6, ≥176px → 5v5.

interface FormatConfig {
  rowsPerTeam: number
  iconXStart: number
  iconXEnd: number
  portraitCropX: number
  portraitCropW: number
  /** Multiple portrait crop variants for multi-crop matching.
   *  Each variant tries a slightly different X/W to avoid decorative overlays. */
  portraitCropConfigs: { cropX: number; cropW: number }[]
  gamertagDisplayCropX: number
  gamertagDisplayCropW: number
  gamertagCropConfigs: { yStart: number; yEnd: number; xStart: number; xEnd: number }[]
}

const FORMAT_5V5: FormatConfig = {
  rowsPerTeam: 5,
  iconXStart: 1082,
  iconXEnd: 1109,
  portraitCropX: 1130,
  portraitCropW: 122,
  portraitCropConfigs: [
    { cropX: 1130, cropW: 122 },  // original/primary
    { cropX: 1125, cropW: 110 },  // slightly left, narrower
    { cropX: 1140, cropW: 100 },  // slightly right, narrower
    { cropX: 1135, cropW: 90 },   // centered, tightest
  ],
  gamertagDisplayCropX: 1272,
  gamertagDisplayCropW: 390,
  gamertagCropConfigs: [
    { yStart: 17, yEnd: 91, xStart: 1272, xEnd: 1497 },
    { yStart: 17, yEnd: 91, xStart: 1272, xEnd: 1520 },
    { yStart: 17, yEnd: 91, xStart: 1275, xEnd: 1700 },
  ],
}

const FORMAT_6V6: FormatConfig = {
  rowsPerTeam: 6,
  iconXStart: 1150,
  iconXEnd: 1220,
  portraitCropX: 1215,
  portraitCropW: 105,
  portraitCropConfigs: [
    { cropX: 1215, cropW: 105 },  // original/primary
    { cropX: 1210, cropW: 110 },  // slightly left, wider — avoids right-side badges
    { cropX: 1220, cropW: 100 },  // slightly right, narrower — avoids left-side overlays
    { cropX: 1225, cropW: 90 },   // rightmost, tightest — maximum badge avoidance
  ],
  gamertagDisplayCropX: 1340,
  gamertagDisplayCropW: 360,
  gamertagCropConfigs: [
    { yStart: 17, yEnd: 91, xStart: 1340, xEnd: 1565 },
    { yStart: 17, yEnd: 91, xStart: 1340, xEnd: 1590 },
    { yStart: 17, yEnd: 91, xStart: 1343, xEnd: 1700 },
  ],
}

function getFormatConfig(format: '5v5' | '6v6' | null): FormatConfig {
  return format === '6v6' ? FORMAT_6V6 : FORMAT_5V5
}

// Gamertag OCR crop configs — measured pixel-exact from all 7 test screenshots.
// PYROEAGLES text: x=1277–1487 (always 209px), y_offset=+20 to +88 (always 41px tall).
// 3 configs × 2 scales = 6 OCR attempts per slot.
const GAMERTAG_CROP_CONFIGS = [
  { yStart: 17, yEnd: 91, xStart: 1272, xEnd: 1497 },
  { yStart: 17, yEnd: 91, xStart: 1272, xEnd: 1520 },
  { yStart: 17, yEnd: 91, xStart: 1275, xEnd: 1700 },
]

// Template matching constants
const SB_NORM_H = 64           // Normalized height for template matching
const SB_CELL_Y_START = 35     // Relative to row top — safe crop zone start
const SB_CELL_Y_END = 110      // Relative to row top — safe crop zone end
const SB_THRESHOLDS = [150, 160, 170]  // Multi-threshold voting
const SB_MIN_BLOB_AREA = 10    // Minimum blob area to keep

const STAT_COL_KEYS: Array<{ key: keyof typeof SCOREBOARD_COLUMNS; field: keyof ScoreboardPlayerStats }> = [
  { key: 'E',   field: 'eliminations' },
  { key: 'A',   field: 'assists' },
  { key: 'D',   field: 'deaths' },
  { key: 'DMG', field: 'damage' },
  { key: 'H',   field: 'healing' },
  { key: 'MIT', field: 'mitigation' },
]

// ============================================================
// COLOR CLASSIFIERS — Used by detectScoreboard
// ============================================================

function isBlue(r: number, g: number, b: number): boolean {
  return r < 40 && g > 60 && b > 90
}

function isRed(r: number, g: number, b: number): boolean {
  return r > 70 && g < 50 && b < 70
}

function isDark(r: number, g: number, b: number): boolean {
  return r < 35 && g < 45 && b < 65
}

function getPixel(data: Uint8ClampedArray, width: number, x: number, y: number): [number, number, number] {
  const i = (y * width + x) * 4
  return [data[i], data[i + 1], data[i + 2]]
}

// ============================================================
// STEP 1: SCOREBOARD DETECTION
// Uses pixel color sampling — no OCR needed.
// Scoreboards have a unique blue-ally / dark-VS / red-enemy
// vertical color pattern that no other page type has.
// ============================================================

export async function detectScoreboard(img: HTMLImageElement): Promise<ScoreboardDetectionResult> {
  const w = img.naturalWidth
  const h = img.naturalHeight
  const signals: string[] = []

  // Must be 3840×2160 (PS5 screenshot resolution)
  if (w !== 3840 || h !== 2160) {
    return {
      imageType: 'unknown',
      confidence: 0,
      signals: [`Unexpected resolution: ${w}×${h} (expected 3840×2160)`],
      grid: null,
      format: null,
    }
  }

  // Get pixel data
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, w, h)
  const px = imageData.data

  // --- Signal 1: Check for blue ally section in upper portion ---
  const sampleX = 1800
  const blueCheckYs = [550, 700, 850]
  let blueCount = 0
  for (const y of blueCheckYs) {
    const [r, g, b] = getPixel(px, w, sampleX, y)
    if (isBlue(r, g, b)) blueCount++
  }
  const hasBlue = blueCount >= 2
  signals.push(`Blue ally zone: ${blueCount}/3 samples (${hasBlue ? 'YES' : 'NO'})`)

  // --- Signal 2: Check for red enemy section in lower portion ---
  const redCheckYs = [1450, 1600, 1750]
  let redCount = 0
  for (const y of redCheckYs) {
    const [r, g, b] = getPixel(px, w, sampleX, y)
    if (isRed(r, g, b)) redCount++
  }
  const hasRed = redCount >= 2
  signals.push(`Red enemy zone: ${redCount}/3 samples (${hasRed ? 'YES' : 'NO'})`)

  // --- Signal 3: Check for dark VS gap between blue and red ---
  const gapCheckYs = [1180, 1220, 1260]
  let darkCount = 0
  for (const y of gapCheckYs) {
    const [r, g, b] = getPixel(px, w, sampleX, y)
    if (isDark(r, g, b)) darkCount++
  }
  const hasGap = darkCount >= 2
  signals.push(`VS dark gap: ${darkCount}/3 samples (${hasGap ? 'YES' : 'NO'})`)

  // --- Classification ---
  const isScoreboard = hasBlue && hasRed && hasGap
  if (!isScoreboard) {
    const confidence = (blueCount + redCount + darkCount) / 9
    return {
      imageType: 'unknown',
      confidence,
      signals,
      grid: null,
      format: null,
    }
  }

  // --- Grid mapping: find exact section boundaries ---
  // Scan for ally section end: look for consecutive dark pixels (VS gap)
  // Must scan past y=1200 since 6v6 ally sections can extend to y=1200
  let allyEndY = 0
  let darkRunCount = 0
  for (let y = 1050; y < 1250; y++) {
    const [r, g, b] = getPixel(px, w, sampleX, y)
    if (isDark(r, g, b)) {
      darkRunCount++
      if (darkRunCount >= 3) {
        allyEndY = y - 2  // first dark pixel in the run
        break
      }
    } else {
      darkRunCount = 0
    }
  }
  if (allyEndY === 0) allyEndY = 1183
  signals.push(`Ally section ends at y=${allyEndY}`)

  let allyStartY = 0
  for (let y = 500; y > 400; y--) {
    const [r, g, b] = getPixel(px, w, sampleX, y)
    if (!isBlue(r, g, b)) {
      allyStartY = y + 1
      break
    }
  }
  if (allyStartY === 0) allyStartY = 478
  signals.push(`Ally section starts at y=${allyStartY}`)

  let enemyStartY = 0
  for (let y = 1250; y < 1400; y++) {
    const [r, g, b] = getPixel(px, w, sampleX, y)
    if (isRed(r, g, b)) {
      enemyStartY = y
      break
    }
  }
  if (enemyStartY === 0) enemyStartY = 1330
  signals.push(`Enemy section starts at y=${enemyStartY}`)

  let enemyEndY = 0
  for (let y = 1900; y < 2100; y++) {
    const [r, g, b] = getPixel(px, w, sampleX, y)
    if (!isRed(r, g, b)) {
      enemyEndY = y
      break
    }
  }
  if (enemyEndY === 0) enemyEndY = 1980
  signals.push(`Enemy section ends at y=${enemyEndY}`)

  // Detect format via VS gap height:
  // 5v5 gap = 185–186px, 6v6 gap = 162–168px, threshold at 175px
  const allyHeight = allyEndY - allyStartY
  const enemyHeight = enemyEndY - enemyStartY
  const vsGapHeight = enemyStartY - allyEndY

  const detectedFormat: '5v5' | '6v6' = vsGapHeight <= 175 ? '6v6' : '5v5'
  const fmtCfg = getFormatConfig(detectedFormat)
  const rowsPerTeam = fmtCfg.rowsPerTeam

  const allyRowH = allyHeight / rowsPerTeam
  const enemyRowH = enemyHeight / rowsPerTeam

  signals.push(`VS gap: ${vsGapHeight}px → format=${detectedFormat}`)
  signals.push(`Ally rows: ${allyHeight}px total, ${rowsPerTeam} rows, ~${allyRowH.toFixed(1)}px/row`)
  signals.push(`Enemy rows: ${enemyHeight}px total, ${rowsPerTeam} rows, ~${enemyRowH.toFixed(1)}px/row`)

  const rows: ScoreboardGridRow[] = []
  for (let i = 0; i < rowsPerTeam; i++) {
    const topY = Math.round(allyStartY + allyRowH * i)
    const bottomY = Math.round(allyStartY + allyRowH * (i + 1))
    rows.push({
      slot: i + 1,
      team: 'ally',
      topY,
      centerY: Math.round((topY + bottomY) / 2),
      bottomY,
    })
  }
  for (let i = 0; i < rowsPerTeam; i++) {
    const topY = Math.round(enemyStartY + enemyRowH * i)
    const bottomY = Math.round(enemyStartY + enemyRowH * (i + 1))
    rows.push({
      slot: i + rowsPerTeam + 1,
      team: 'enemy',
      topY,
      centerY: Math.round((topY + bottomY) / 2),
      bottomY,
    })
  }

  const grid: ScoreboardGrid = {
    ally: { startY: allyStartY, endY: allyEndY, rowHeight: allyRowH },
    enemy: { startY: enemyStartY, endY: enemyEndY, rowHeight: enemyRowH },
    rows,
    rowsPerTeam,
    columns: getScoreboardColumns(detectedFormat),
  }

  return {
    imageType: 'scoreboard',
    confidence: 1.0,
    signals,
    grid,
    format: detectedFormat,
  }
}

// ============================================================
// STEP 4: ROLE CLASSIFICATION VIA ICON DETECTION
// Runs BEFORE Step 2. No hero dependency.
// Uses a 2-feature pixel classifier on role icons.
// ============================================================

/** Count the fraction of "bright" pixels (avg brightness > 180) in a rectangular region */
function countBrightFill(
  px: Uint8ClampedArray,
  w: number,
  x1: number, x2: number,
  y1: number, y2: number,
): number {
  let count = 0
  let total = 0
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      const [r, g, b] = getPixel(px, w, x, y)
      total++
      if ((r + g + b) / 3 > 180) count++
    }
  }
  return total > 0 ? count / total : 0
}

/** Find the bounds of the role icon by scanning for bright pixels */
function findIconBounds(
  px: Uint8ClampedArray,
  w: number,
  rowCenterY: number,
  iconXStart: number = ICON_X_START,
  iconXEnd: number = ICON_X_END,
): { top: number; bottom: number; midY: number; left: number; right: number } | null {
  const brightRows: number[] = []

  for (let y = rowCenterY - 30; y <= rowCenterY + 30; y++) {
    let rowBright = 0
    for (let x = iconXStart; x <= iconXEnd; x++) {
      const [r, g, b] = getPixel(px, w, x, y)
      if ((r + g + b) / 3 > 180) rowBright++
    }
    if (rowBright > 2) brightRows.push(y)
  }

  if (brightRows.length === 0) return null

  const top = Math.min(...brightRows)
  const bottom = Math.max(...brightRows)
  const midY = Math.round((top + bottom) / 2)

  // Find actual X bounds within the bright Y range
  let left = iconXEnd
  let right = iconXStart
  for (let y = top; y <= bottom; y++) {
    for (let x = iconXStart; x <= iconXEnd; x++) {
      const [r, g, b] = getPixel(px, w, x, y)
      if ((r + g + b) / 3 > 180) {
        if (x < left) left = x
        if (x > right) right = x
      }
    }
  }

  return { top, bottom, midY, left, right }
}

/** Classify a role icon using the 2-feature decision tree */
function classifyRoleIcon(
  px: Uint8ClampedArray,
  w: number,
  iconBounds: { top: number; bottom: number; midY: number; left: number; right: number },
  iconXStart: number = ICON_X_START,
): 'tank' | 'dps' | 'support' {
  const cx = iconBounds.midY
  const lx = iconBounds.left
  const rx = Math.min(lx + 34, iconBounds.right + 1)
  const THR = 200 // higher threshold to avoid blue/red background noise

  // Feature 1: count rows with 3+ bright segments (DPS three-bar pattern)
  let gapRows = 0
  let totalRows = 0

  for (let yOff = -12; yOff <= 12; yOff += 2) {
    const y = cx + yOff
    let segs = 0
    let inBright = false
    let hasContent = false

    for (let x = lx; x < rx; x++) {
      const [r, g, b] = getPixel(px, w, x, y)
      const isBright = (r + g + b) / 3 > THR
      if (isBright) {
        hasContent = true
        if (!inBright) segs++
        inBright = true
      } else {
        inBright = false
      }
    }

    if (hasContent) {
      totalRows++
      if (segs >= 3) gapRows++
    }
  }

  if (totalRows > 0 && gapRows / totalRows >= 0.3) return 'dps'

  // Feature 2: width at cy-8 (upper) vs cy (mid) — support cross is narrow above center
  let upperCount = 0
  let midCount = 0
  let topCount = 0

  for (let x = lx; x < rx; x++) {
    const [r1, g1, b1] = getPixel(px, w, x, cx - 8)
    if ((r1 + g1 + b1) / 3 > THR) upperCount++

    const [r2, g2, b2] = getPixel(px, w, x, cx)
    if ((r2 + g2 + b2) / 3 > THR) midCount++

    const [r3, g3, b3] = getPixel(px, w, x, cx - 12)
    if ((r3 + g3 + b3) / 3 > THR) topCount++
  }

  if (midCount === 0) return 'tank'

  const rUpper = upperCount / midCount
  const rTop = topCount / midCount

  // Support: narrow upper (cross vertical bar)
  if (rUpper < 0.90) return 'support'

  // When upper is wide: check top — heart is wide at top, cross is narrow
  if (rTop >= 0.45) return 'tank'

  return 'support'
}

export async function classifyRoles(
  img: HTMLImageElement,
  detection: ScoreboardDetectionResult,
): Promise<ScoreboardRoleClassification[]> {
  if (detection.imageType !== 'scoreboard' || !detection.grid) {
    const totalSlots = detection.grid?.rowsPerTeam ? detection.grid.rowsPerTeam * 2 : 10
    const rpt = detection.grid?.rowsPerTeam ?? 5
    const results: ScoreboardRoleClassification[] = []
    for (let i = 1; i <= totalSlots; i++) {
      results.push({
        slot: i, team: i <= rpt ? 'ally' : 'enemy',
        heroName: null, role: null, source: null,
      })
    }
    return results
  }

  const grid = detection.grid
  const fmtCfg = getFormatConfig(detection.format)

  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const px = imageData.data
  const w = canvas.width

  const results: ScoreboardRoleClassification[] = []

  console.log(`Step 4: Role classification via icon detection (${detection.format ?? '5v5'}, icons x=${fmtCfg.iconXStart}–${fmtCfg.iconXEnd})...`)

  for (const row of grid.rows) {
    const iconBounds = findIconBounds(px, w, row.centerY, fmtCfg.iconXStart, fmtCfg.iconXEnd)

    if (!iconBounds) {
      console.warn(`  Slot ${row.slot}: no icon found at centerY=${row.centerY}`)
      results.push({
        slot: row.slot, team: row.team,
        heroName: null, role: null, source: null,
      })
      continue
    }

    const role = classifyRoleIcon(px, w, iconBounds, fmtCfg.iconXStart)

    console.log(
      `  Slot ${row.slot} (${row.team}): ${role} ` +
      `(icon x=${iconBounds.left}–${iconBounds.right} y=${iconBounds.top}–${iconBounds.bottom})`
    )

    results.push({
      slot: row.slot,
      team: row.team,
      heroName: null, // populated after Step 2
      role,
      source: 'icon_detection',
    })
  }

  const totalSlots = grid.rowsPerTeam * 2
  const classified = results.filter(r => r.role !== null).length
  console.log(`Step 4 complete: ${classified}/${totalSlots} roles classified`)

  return results
}

// ============================================================
// STEP 2: HERO IDENTIFICATION (role-filtered)
// Receives roles from Step 4 and passes roleFilter to matchHero()
// reducing candidates from 51 to ~14 per slot.
// Two-pass approach: no-ORB first, ORB for low confidence.
// ============================================================

export async function identifyHeroes(
  img: HTMLImageElement,
  detection: ScoreboardDetectionResult,
  roles: ScoreboardRoleClassification[],
): Promise<ScoreboardHeroIdentification[]> {
  if (detection.imageType !== 'scoreboard' || !detection.grid) {
    const totalSlots = detection.grid?.rowsPerTeam ? detection.grid.rowsPerTeam * 2 : 10
    const rpt = detection.grid?.rowsPerTeam ?? 5
    const results: ScoreboardHeroIdentification[] = []
    for (let i = 1; i <= totalSlots; i++) {
      results.push({
        slot: i,
        team: i <= rpt ? 'ally' : 'enemy',
        heroName: null,
        confidence: 0,
        portraitDataUrl: null,
      })
    }
    return results
  }

  await loadHeroBank()

  const grid = detection.grid

  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = img.naturalWidth
  srcCanvas.height = img.naturalHeight
  const srcCtx = srcCanvas.getContext('2d')!
  srcCtx.drawImage(img, 0, 0)

  // ── Multi-crop portrait extraction ──
  // For each row, crop at multiple X/W positions to mitigate decorative
  // overlays (rank titles, badges, nameplates) that corrupt any single crop.
  // Each pass tries all crop variants and picks the highest-confidence match.

  interface CropVariant {
    portraitData: { data: number[]; width: number; height: number }
  }

  interface PortraitCropSet {
    slot: number
    team: 'ally' | 'enemy'
    variants: CropVariant[]
    portraitDataUrl: string  // thumbnail from primary (first) crop for display
  }

  const portraits: PortraitCropSet[] = []

  const fmtCfg = getFormatConfig(detection.format)
  const cropConfigs = fmtCfg.portraitCropConfigs

  console.log(`Step 2: Multi-crop portrait extraction (${cropConfigs.length} variants per slot)...`)

  for (const row of grid.rows) {
    const cropY = row.topY + 4
    const cropH = (row.bottomY - row.topY) - 8
    const variants: CropVariant[] = []
    let portraitDataUrl = ''

    for (let ci = 0; ci < cropConfigs.length; ci++) {
      const { cropX, cropW } = cropConfigs[ci]

      const cropCanvas = document.createElement('canvas')
      cropCanvas.width = cropW
      cropCanvas.height = cropH
      cropCanvas.getContext('2d')!.drawImage(srcCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)

      // Generate display thumbnail from the primary (first) crop only
      if (ci === 0) {
        const thumbCanvas = document.createElement('canvas')
        thumbCanvas.width = 64
        thumbCanvas.height = 64
        thumbCanvas.getContext('2d')!.drawImage(cropCanvas, 0, 0, 64, 64)
        portraitDataUrl = thumbCanvas.toDataURL('image/png')
      }

      const matchCanvas = document.createElement('canvas')
      matchCanvas.width = 128
      matchCanvas.height = 128
      matchCanvas.getContext('2d')!.drawImage(cropCanvas, 0, 0, 128, 128)
      const matchImageData = matchCanvas.getContext('2d')!.getImageData(0, 0, 128, 128)

      variants.push({
        portraitData: {
          data: Array.from(matchImageData.data),
          width: 128,
          height: 128,
        },
      })
    }

    portraits.push({ slot: row.slot, team: row.team, variants, portraitDataUrl })
  }

  // ── Phase 1 (Step 6b) — cheap crop selection ──
  // For a slot, score every crop variant with structural+color ONLY against
  // ALL 51 heroes (no role filter, no ORB), and return the index of the
  // "cleanest" crop — the one whose best all-hero match scores highest.
  //
  // Why all-51 and not role-filtered: the role icon classifier is the weakest
  // input in the pipeline. Restricting Phase 1 to the role subset risks the
  // correct hero being absent from the comparison when the icon role is wrong,
  // which would make the selected crop optimal for the WRONG target. Scoring
  // against all heroes keeps the correct hero always in play and uses the same
  // basis as matchHero()'s internal sanity check.
  //
  // The returned phase1Score is ONLY for ranking crops against each other.
  // It is NOT calibrated against ORB_THRESHOLD and is never used as the
  // low-confidence gate (that gate uses the role-filtered matchHero score).
  async function selectCleanestCrop(
    variants: CropVariant[],
  ): Promise<{ bestVariant: number; phase1Score: number; phase1Hero: string }> {
    let bestVariant = 0
    let phase1Score = -Infinity
    let phase1Hero = ''

    for (let vi = 0; vi < variants.length; vi++) {
      const s = await scoreCropAgainstAllHeroes(variants[vi].portraitData)
      if (s.score > phase1Score) {
        phase1Score = s.score
        bestVariant = vi
        phase1Hero = s.heroName
      }
    }

    return { bestVariant, phase1Score, phase1Hero }
  }

  // ── Phase 2 ORB net (Step 6b) — multi-crop ORB for low-confidence slots ──
  // Retained as the original safety net: for the rare slots below threshold,
  // run the full ORB pipeline across ALL crop variants and take the best.
  // These slots are few, so the multi-crop ORB cost here is small, and it
  // preserves the exact behaviour that earned the 100% on hard portraits.
  async function bestMultiCropOrbMatch(
    variants: CropVariant[],
    roleFilter?: RoleType,
  ): Promise<{ heroName: string; score: number; margin: number; runnerUp: string; correctedRole?: RoleType; bestVariant: number }> {
    let best: { heroName: string; score: number; margin: number; runnerUp: string; correctedRole?: RoleType; bestVariant: number } | null = null

    for (let vi = 0; vi < variants.length; vi++) {
      const match = await matchHero(variants[vi].portraitData, true, roleFilter)
      if (!best || match.score > best.score) {
        best = { ...match, bestVariant: vi }
      }
    }

    return best!
  }

  // ── PASS 1 (Step 6b two-phase): select cleanest crop, then ONE full match ──
  // Phase 1: rank crops (cheap, all-51 structural+color).
  // Phase 2: run the full role-filtered matchHero() pipeline on the winner only.
  // This replaces the previous "full matchHero × every crop" approach
  // (4 full pipelines per slot → 1 full pipeline + 4 cheap scores per slot).

  const ORB_THRESHOLD = 0.35
  const results: ScoreboardHeroIdentification[] = []
  const lowConfidenceIndices: number[] = []

  console.log('Step 2 Pass 1: two-phase crop selection (Phase 1: cheap all-51 crop rank; Phase 2: role-filtered full match on winner)...')

  for (let i = 0; i < portraits.length; i++) {
    const p = portraits[i]
    const roleForSlot = roles.find(r => r.slot === p.slot)?.role ?? undefined

    try {
      // Phase 1 — pick the cleanest crop (cheap, no ORB, no role filter, all 51)
      const sel = await selectCleanestCrop(p.variants)
      const winningCrop = p.variants[sel.bestVariant]

      // Phase 2 — full role-filtered pipeline on the winning crop ONLY
      const match = await matchHero(winningCrop.portraitData, false, roleForSlot as RoleType | undefined)

      console.log(
        `  [P1] Slot ${p.slot} (${p.team}): ${match.heroName} ` +
        `(score: ${match.score.toFixed(4)}, margin: ${match.margin.toFixed(4)}, ` +
        `runner-up: ${match.runnerUp}, crop: ${sel.bestVariant + 1}/${cropConfigs.length} ` +
        `[phase1: ${sel.phase1Hero} ${sel.phase1Score.toFixed(4)}]` +
        `${roleForSlot ? `, role-filter: ${roleForSlot}` : ''}` +
        `${match.correctedRole ? `, ROLE CORRECTED → ${match.correctedRole}` : ''})`
      )

      results.push({
        slot: p.slot,
        team: p.team,
        heroName: match.heroName,
        confidence: match.score,
        portraitDataUrl: p.portraitDataUrl,
      })

      // Low-confidence gate uses the role-filtered matchHero score — the
      // same quantity ORB_THRESHOLD was originally tuned against, so the
      // set of slots sent to the ORB net is unchanged by the 6b rework.
      if (match.score < ORB_THRESHOLD) {
        lowConfidenceIndices.push(i)
      }
    } catch (err) {
      console.error(`Hero match failed for slot ${p.slot}:`, err)
      results.push({
        slot: p.slot,
        team: p.team,
        heroName: null,
        confidence: 0,
        portraitDataUrl: p.portraitDataUrl,
      })
    }
  }

  // ── PASS 2: ORB for low-confidence matches (role-filtered, multi-crop net) ──

  if (lowConfidenceIndices.length > 0) {
    console.log(
      `Step 2 Pass 2: ${lowConfidenceIndices.length} portrait(s) below ${(ORB_THRESHOLD * 100).toFixed(0)}% ` +
      `— slots [${lowConfidenceIndices.map(i => results[i].slot).join(', ')}] — initializing ORB (multi-crop net)...`
    )

    const opencvReady = await initOpenCV()

    if (opencvReady) {
      for (const i of lowConfidenceIndices) {
        const p = portraits[i]
        const prevName = results[i].heroName
        const prevScore = results[i].confidence
        const roleForSlot = roles.find(r => r.slot === p.slot)?.role ?? undefined

        try {
          const orbMatch = await bestMultiCropOrbMatch(p.variants, roleForSlot as RoleType | undefined)

          console.log(
            `  [P2] Slot ${p.slot}: ${prevName} (${(prevScore * 100).toFixed(1)}%) → ` +
            `${orbMatch.heroName} (${(orbMatch.score * 100).toFixed(1)}%, ` +
            `margin: ${orbMatch.margin.toFixed(4)}, runner-up: ${orbMatch.runnerUp}, ` +
            `crop: ${orbMatch.bestVariant + 1}/${cropConfigs.length}` +
            `${roleForSlot ? `, role-filter: ${roleForSlot}` : ''}` +
            `${orbMatch.correctedRole ? `, ROLE CORRECTED → ${orbMatch.correctedRole}` : ''})`
          )

          results[i].heroName = orbMatch.heroName
          results[i].confidence = orbMatch.score
        } catch (err) {
          console.warn(`  [P2] ORB failed for slot ${p.slot}, keeping Pass 1 result:`, err)
        }
      }
    } else {
      console.warn('OpenCV failed to initialize — keeping Pass 1 results for all low-confidence matches')
    }
  } else {
    console.log('Step 2 Pass 2: skipped — all portraits above confidence threshold')
  }

  // Override icon-detected roles with the identified hero's known role.
  // This ensures roles are always correct regardless of icon classifier accuracy.
  overrideRolesFromHeroes(roles, results)

  return results
}

// ============================================================
// STEP 3 TIER 2: USER IDENTIFICATION VIA HERO MATCH
// If we already know which heroes the user played (from summary
// or breakdown pages), check if exactly one ally slot has one
// of those heroes. If so, the user is identified without OCR.
// ============================================================

export interface HeroMatchIdentification {
  resolved: boolean
  userSlot: number | null
  matchedHero: string | null
  method: 'hero_match'
  details: string
}

export function identifyUserByHeroMatch(
  scoreboardHeroes: ScoreboardHeroIdentification[],
  knownUserHeroes: string[],
): HeroMatchIdentification {
  if (knownUserHeroes.length === 0) {
    return {
      resolved: false, userSlot: null, matchedHero: null,
      method: 'hero_match',
      details: 'No known user heroes to match against',
    }
  }

  // Only check ally slots (1-5)
  const allyHeroes = scoreboardHeroes.filter(h => h.team === 'ally' && h.heroName)

  // Find ally slots whose hero appears in the user's known hero list
  const matchingSlots = allyHeroes.filter(h =>
    knownUserHeroes.includes(h.heroName!)
  )

  console.log(
    `Tier 2 hero-match: known user heroes [${knownUserHeroes.join(', ')}] ` +
    `vs ally slots [${allyHeroes.map(h => `${h.slot}:${h.heroName}`).join(', ')}]`
  )

  if (matchingSlots.length === 0) {
    return {
      resolved: false, userSlot: null, matchedHero: null,
      method: 'hero_match',
      details: `No ally slot matches known user heroes [${knownUserHeroes.join(', ')}]`,
    }
  }

  if (matchingSlots.length === 1) {
    const slot = matchingSlots[0]
    console.log(
      `Tier 2 RESOLVED: slot ${slot.slot} has ${slot.heroName} ` +
      `(matches known user hero) — skipping OCR`
    )
    return {
      resolved: true,
      userSlot: slot.slot,
      matchedHero: slot.heroName,
      method: 'hero_match',
      details: `Slot ${slot.slot} (${slot.heroName}) is the only ally matching known user heroes`,
    }
  }

  // Multiple ally slots match the user's heroes — ambiguous (e.g. mirror match
  // or user played multiple heroes and teammates played the same ones)
  console.log(
    `Tier 2 ambiguous: ${matchingSlots.length} ally slots match ` +
    `[${matchingSlots.map(s => `${s.slot}:${s.heroName}`).join(', ')}] — falling through to OCR`
  )
  return {
    resolved: false, userSlot: null, matchedHero: null,
    method: 'hero_match',
    details: `${matchingSlots.length} ally slots match — ambiguous`,
  }
}

// ============================================================
// STEP 3: USER IDENTIFICATION VIA GAMERTAG OCR
// OCR ally username regions, fuzzy-match against gamertag.
// Other player names are NEVER stored — only isUser boolean.
// ============================================================

// Tesseract worker — lazy singleton
let tesseractWorker: Tesseract.Worker | null = null

async function getTesseractWorker(): Promise<Tesseract.Worker> {
  if (!tesseractWorker) {
    tesseractWorker = await Tesseract.createWorker('eng')
    await tesseractWorker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE, // single text line
    })
  }
  return tesseractWorker
}

/** Terminate the scoreboard OCR worker (cleanup) */
export async function terminateScoreboardOcr(): Promise<void> {
  if (tesseractWorker) {
    await tesseractWorker.terminate()
    tesseractWorker = null
  }
}

/** Levenshtein edit distance */
function levenshtein(s1: string, s2: string): number {
  if (s1.length < s2.length) return levenshtein(s2, s1)
  if (s2.length === 0) return s1.length

  let prev = Array.from({ length: s2.length + 1 }, (_, i) => i)

  for (let i = 0; i < s1.length; i++) {
    const curr = [i + 1]
    for (let j = 0; j < s2.length; j++) {
      const cost = s1[i] !== s2[j] ? 1 : 0
      curr.push(Math.min(
        prev[j + 1] + 1,
        curr[j] + 1,
        prev[j] + cost,
      ))
    }
    prev = curr
  }

  return prev[s2.length]
}

/** Normalized similarity: 0 = no match, 1 = perfect match */
function stringSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1
  const dist = levenshtein(a.toUpperCase(), b.toUpperCase())
  return 1 - dist / Math.max(a.length, b.length)
}

/** Preprocess a gamertag crop: threshold → binary */
function preprocessGamertagCrop(
  srcCanvas: HTMLCanvasElement,
  row: ScoreboardGridRow,
  cropCfg: { yStart: number; yEnd: number; xStart: number; xEnd: number },
): HTMLCanvasElement {
  const cropX = cropCfg.xStart
  const cropY = row.topY + cropCfg.yStart
  const cropW = cropCfg.xEnd - cropCfg.xStart
  const cropH = cropCfg.yEnd - cropCfg.yStart

  const cropCanvas = document.createElement('canvas')
  cropCanvas.width = cropW
  cropCanvas.height = cropH
  const cropCtx = cropCanvas.getContext('2d')!
  cropCtx.drawImage(srcCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)

  const cropData = cropCtx.getImageData(0, 0, cropW, cropH)
  const binaryCanvas = document.createElement('canvas')
  binaryCanvas.width = cropW
  binaryCanvas.height = cropH
  const binaryCtx = binaryCanvas.getContext('2d')!
  const binaryData = binaryCtx.createImageData(cropW, cropH)

  for (let i = 0; i < cropData.data.length; i += 4) {
    const avg = (cropData.data[i] + cropData.data[i + 1] + cropData.data[i + 2]) / 3
    const val = avg > 180 ? 0 : 255
    binaryData.data[i] = val
    binaryData.data[i + 1] = val
    binaryData.data[i + 2] = val
    binaryData.data[i + 3] = 255
  }
  binaryCtx.putImageData(binaryData, 0, 0)

  return binaryCanvas
}

/** Scale a binary canvas by a given factor (nearest-neighbor) */
function scaleCanvas(binary: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const scaled = document.createElement('canvas')
  scaled.width = binary.width * factor
  scaled.height = binary.height * factor
  const ctx = scaled.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(binary, 0, 0, scaled.width, scaled.height)
  return scaled
}

/**
 * OCR a single row with multiple crop configs × multiple scales.
 * Returns the text with highest similarity to the target.
 */
async function ocrBestOfVariants(
  worker: Tesseract.Worker,
  srcCanvas: HTMLCanvasElement,
  row: ScoreboardGridRow,
  target: string,
  cropConfigs: { yStart: number; yEnd: number; xStart: number; xEnd: number }[] = GAMERTAG_CROP_CONFIGS,
): Promise<{ text: string; similarity: number }> {
  let bestText = ''
  let bestSim = 0

  for (const cropCfg of cropConfigs) {
    const binaryCanvas = preprocessGamertagCrop(srcCanvas, row, cropCfg)

    for (const scale of [3, 4]) {
      const scaled = scaleCanvas(binaryCanvas, scale)
      const { data: { text } } = await worker.recognize(scaled)
      const clean = text.replace(/[\s\n]/g, '')
      const s = stringSimilarity(clean, target)

      if (s > bestSim) {
        bestSim = s
        bestText = clean
      }
    }
  }

  return { text: bestText, similarity: bestSim }
}

/** Generate positional label from role + team + count */
function buildPositionalLabels(
  roles: ScoreboardRoleClassification[],
): Map<number, string> {
  const labels = new Map<number, string>()

  for (const team of ['ally', 'enemy'] as const) {
    const teamLabel = team === 'ally' ? 'Ally' : 'Enemy'
    const teamRoles = roles.filter(r => r.team === team)

    const roleCounts: Record<string, number> = { tank: 0, dps: 0, support: 0 }
    const roleTotals: Record<string, number> = { tank: 0, dps: 0, support: 0 }

    for (const r of teamRoles) {
      if (r.role) roleTotals[r.role]++
    }

    for (const r of teamRoles) {
      if (r.role) {
        roleCounts[r.role]++
        const roleLabel = r.role === 'tank' ? 'Tank' :
                          r.role === 'dps' ? 'DPS' : 'Support'
        const number = roleTotals[r.role] > 1 ? ` ${roleCounts[r.role]}` : ''
        labels.set(r.slot, `${teamLabel} ${roleLabel}${number}`)
      } else {
        labels.set(r.slot, `${teamLabel} Unknown`)
      }
    }
  }

  return labels
}

export async function analyzeUserIdentity(
  img: HTMLImageElement,
  heroes: ScoreboardHeroIdentification[],
  detection: ScoreboardDetectionResult,
  roles: ScoreboardRoleClassification[],
  gamertag: string,
): Promise<ScoreboardOcrAnalysis> {
  const fmtCfg = getFormatConfig(detection.format)
  const allyCount = fmtCfg.rowsPerTeam

  const emptyCandidates: ScoreboardUserCandidate[] = Array.from({ length: allyCount }, (_, i) => ({
    slot: i + 1,
    heroName: heroes.find(h => h.slot === i + 1)?.heroName ?? null,
    heroPortraitUrl: heroes.find(h => h.slot === i + 1)?.portraitDataUrl ?? null,
    gamertagCropUrl: null,
    ocrSimilarity: 0,
  }))

  if (detection.imageType !== 'scoreboard' || !detection.grid || !gamertag.trim()) {
    return {
      resolved: false,
      userSlot: null,
      bestCandidate: { slot: 1, similarity: 0, margin: 0 },
      candidates: emptyCandidates,
    }
  }

  const grid = detection.grid

  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = img.naturalWidth
  srcCanvas.height = img.naturalHeight
  srcCanvas.getContext('2d')!.drawImage(img, 0, 0)

  const allyRows = grid.rows.filter(r => r.team === 'ally')
  console.log(`Step 3: Checking all ${allyCount} ally rows for user identification`)

  // Extract raw gamertag crops for display (unthresholded, human-readable)
  const gamertagCrops = new Map<number, string>()
  for (const row of allyRows) {
    const cropX = fmtCfg.gamertagDisplayCropX
    const cropY = row.topY + 17
    const cropW = fmtCfg.gamertagDisplayCropW
    const cropH = 74
    const cropCanvas = document.createElement('canvas')
    cropCanvas.width = cropW
    cropCanvas.height = cropH
    cropCanvas.getContext('2d')!.drawImage(srcCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)
    gamertagCrops.set(row.slot, cropCanvas.toDataURL('image/png'))
  }

  console.log('Step 3: Initializing Tesseract OCR...')
  const worker = await getTesseractWorker()

  interface OcrMatch {
    slot: number
    similarity: number
    ocrText: string
  }
  const matches: OcrMatch[] = []

  for (const row of allyRows) {
    const best = await ocrBestOfVariants(worker, srcCanvas, row, gamertag, fmtCfg.gamertagCropConfigs)

    console.log(
      `  Slot ${row.slot}: OCR="${best.text}" → similarity to "${gamertag}": ${(best.similarity * 100).toFixed(0)}%`
    )

    matches.push({ slot: row.slot, similarity: best.similarity, ocrText: best.text })
  }

  const sorted = [...matches].sort((a, b) => b.similarity - a.similarity)
  const best = sorted[0]
  const runnerUp = sorted.length > 1 ? sorted[1] : null
  const margin = runnerUp ? best.similarity - runnerUp.similarity : best.similarity

  const candidates: ScoreboardUserCandidate[] = allyRows.map(row => {
    const match = matches.find(m => m.slot === row.slot)!
    return {
      slot: row.slot,
      heroName: heroes.find(h => h.slot === row.slot)?.heroName ?? null,
      heroPortraitUrl: heroes.find(h => h.slot === row.slot)?.portraitDataUrl ?? null,
      gamertagCropUrl: gamertagCrops.get(row.slot) ?? null,
      ocrSimilarity: match.similarity,
    }
  })

  const MIN_SIMILARITY = 0.30
  const MIN_MARGIN = 0.15
  const resolved = best.similarity >= MIN_SIMILARITY && margin >= MIN_MARGIN

  if (resolved) {
    console.log(
      `Step 3 result: OCR AUTO-RESOLVED → slot ${best.slot} ` +
      `(similarity: ${(best.similarity * 100).toFixed(0)}%, ` +
      `margin: ${(margin * 100).toFixed(0)}% over slot ${runnerUp?.slot ?? 'N/A'})`
    )
  } else {
    console.warn(
      `Step 3 result: OCR NOT CONFIDENT — needs manual confirmation. ` +
      `Best: slot ${best.slot} at ${(best.similarity * 100).toFixed(0)}%, ` +
      `margin: ${(margin * 100).toFixed(0)}%`
    )
  }

  return {
    resolved,
    userSlot: resolved ? best.slot : null,
    bestCandidate: { slot: best.slot, similarity: best.similarity, margin },
    candidates,
  }
}

/** Build final PlayerLabel[] from a chosen user slot */
export function buildPlayerLabels(
  heroes: ScoreboardHeroIdentification[],
  roles: ScoreboardRoleClassification[],
  gamertag: string,
  userSlot: number | null,
  method: 'ocr_auto' | 'ocr_confirmed' | 'manual_select' | 'hero_match' | null,
): ScoreboardPlayerLabel[] {
  const positionalLabels = buildPositionalLabels(roles)
  const results: ScoreboardPlayerLabel[] = []

  for (const role of roles) {
    const i = role.slot
    const hero = heroes.find(h => h.slot === i)
    results.push({
      slot: i,
      team: role.team,
      heroName: hero?.heroName ?? null,
      isUser: i === userSlot,
      userMatchMethod: i === userSlot ? method : null,
      positionalLabel: positionalLabels.get(i) ?? null,
      displayName: i === userSlot ? gamertag : (positionalLabels.get(i) ?? null),
    })
  }

  return results
}

// ============================================================
// STEP 5: STATS EXTRACTION — Template Matching Engine
// Reuses breakdown-ocr digit templates (0-9) with adapted
// binarization threshold (160 vs 120) for coloured backgrounds.
// Multi-threshold voting: 150/160/170.
// ============================================================

// Digit templates — bit-packed base64, 64px normalized height.
// Identical to breakdown-ocr.ts TEMPLATE_DATA (digits only).
const DIGIT_TEMPLATES: Record<string, { w: number; h: number; b64: string }> = {
  '0': { w: 49, h: 64, b64: 'AAAP+AAAAAB//+AAAAA///AAAAH///8AAAH////AAAP////4AAH////8AAH/////AAH/////wAD/////8AH//////AD//////gD//8H//4B//4A//8A//4AP/+A//4AH//gf/4AA//wP/8AAP/4f/8AAH//P/+AAD//n//AAA//z//AAAf/5//gAAP/8//wAAH/+//4AAD////4AAA////8AAAf///+AAAP////AAAH////gAAD////wAAB////wAAA////4AAAf///+AAAP////AAAH////gAAD////wAAB////4AAA////8AAAf///+AAAP////AAAH////wAAH/+f/4AAD//P/8AAB//n/+AAA//z//gAA//5//wAAf/8//4AAP/4H/+AAP/8D//gAP//Af/+AP//AP//5///gD//////gB//////wA//////4AH/////wAB/////wAA/////4AAP////4AAB////wAAAf///wAAAP///4AAAAf//AAA=' },
  '1': { w: 21, h: 64, b64: '//////////////////////////////////////7///AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4A//' },
  '2': { w: 46, h: 64, b64: 'AAD/4AAAAH///AAAAf//8AAAP///+AAB////+AAf////8AB/////wAP/////gA//////gH/////+Af/////8B//////wf//gf//h//+A//+H//AB//4f/4AB//j//gAD//v/+AAP/+//wAA//7//AAD//v/4AAP/+//gAA//7/+AAD//v/4AAP/+f/AAA//4AAAAD/+AAAAAP/4AAAAB//gAAAAH/+AAAAA//4AAAAH//AAAAA//8AAAAD//wAAAAf/+AAAAD//4AAAAf/+AAAAB//4AAAAP//AAAAB//4AAAAP//gAAAA//4AAAAH//gAAAA//8AAAAD//wAAAA//+AAAAH//gAAAAf/+AAAAD//wAAAAf/+AAAAD//wAAAAf/+AAAAB//4AAAAf//AAAAD//8AAAAP/////8B//////wf//////B//////8H//////w///////H//////9///////3///////f//////8=' },
  '3': { w: 43, h: 64, b64: 'AAD/4AAAAf//wAAAP//4AAA////gAA////8AA/////gAf////wA/////4A/////+Af/////AP/////wP/////4H/+AP//D/+AH//h//AB//z//AAf/5//AAP/8//gAH/+f/gAD//AAAAB//gAAAA//wAAAAf/4AAAAP/8AAAAP/4AAAAH/8AAAAH/+AAAA//+AAAP///AAAH///AAAD///gAAB///AAAA///gAAAf//wAAAP//+AAAH///gAAD///4AAB///8AAAP///gAAAD//wAAAA//4AAAAf/8AAAAH//AAAAB//gAAAA//wAAAAP/4AAAAH///8AAD///+AAB////gAA////wAB////8AA/////AA//9//wA//8//////+H//////D/////+B//////Af/////AP/////gD/////gAf////AAH////AAD////gAAP//+AA=' },
  '4': { w: 51, h: 64, b64: 'AAAAA//gAAAAAP/8AAAAAB//gAAAAAf/8AAAAAH//gAAAAA//8AAAAAP//gAAAAD//8AAAAAf//gAAAAD//8AAAAB///gAAAAf//8AAAAD///gAAAA///8AAAAH///gAAAD///8AAAAf///gAAAH///8AAAA////gAAAf///8AAAD////gAAA////8AAAH/9//gAAA//P/8AAAP/x//gAAH/+P/8AAA//h//gAAP/8P/8AAB/+B//gAAf/wP/8AAD/+B//gAB//gP/8AAP/4B//gAD/8AP/8AAf/gB//gAP/8AP/8AD//AB//gAf/4AP/8AD//AB//gA////////f///////7////////f//////////////////////////////////////////////////////////////////+AAAAB//gAAAAAP/8AAAAAB//gAAAAAP/8AAAAAB//gAAAAAP/8AAAAAB//gAAAAAP/8AAAAAB//gAAAAAP/8AAAAAB//gAAAAAP/8AAAAAB//gAAAAAP/8A' },
  '5': { w: 43, h: 64, b64: 'AP////4AH////8AD////+AB/////AA/////gAf////wAP////4AH////8AH////+AD/////AB/////gA/////gAf/gAAAAP/wAAAAH/4AAAAD/8AAAAB/+AAAAB/+AAAAA//AAAAAf/gAAAAP/wAAAAP//8AAAH///+AAD////AAB////4AA/////AA/////wAf////8AP/////AH/////wD/////4B/////+A/wH///AeAAH//4OAAD//8AAAAf/+AAAAH//gAAAD//wAAAA//4AAAAf/8AAAAH/+AAAAD//AAAAB//gAAAA//wAAAAf/4AAAAP/8AAAAP/+wAAAH//cAAAD//PgAAH//n8AAH//z/wAH//5/4AD//w//////4//////4f/////8P/////8H/////4D/////8B/////8A/////8AD////4AB////8AAH///wAA=' },
  '6': { w: 49, h: 64, b64: 'AAAB//wAAAAB//4AAAAA//8AAAAA//8AAAAA//4AAAAA//8AAAAAf/8AAAAAf/+AAAAAP/+AAAAAH/+AAAAAP/+AAAAAP//AAAAAH//AAAAAH//gAAAAH//gAAAAH//gAAAAH//gAAAAD//wAAAAD//wAAAAB//wAAAAD//4AAAAB//4AAAAB////4AAA////8AAAf////wAA//////AA//////wAf/////4AP/////+AP//////wH//////4D//////+B///////D//8AH//5//+AB//8//4AAP/+f/8AAH//v/+AAB////+AAA////+AAAP////AAAH////gAAD////wAAB////4AAA////8AAAf////AAAP////gAAP////wAAH//f/8AAD//v//AAD//n//wAH//z//8AH//4f//gD//wP//////4D//////4B//////8Af/////+AD/////8AB/////8AAf////+AAD////+AAA////4AAAf///8AAAB///8AA=' },
  '7': { w: 50, h: 64, b64: 'f///////3///////9////////f///////n///////5///////+f//////+H///////h///////wf//////8H///////B///////AH//////wAAAAA//4AAAAAP/+AAAAAH//AAAAAB//wAAAAA//8AAAAAf/8AAAAAH//AAAAAD//wAAAAA//4AAAAAf/8AAAAAH//AAAAAD//wAAAAA//wAAAAAf/8AAAAAH//AAAAAH//gAAAAB//wAAAAAf/8AAAAAP/+AAAAAH//gAAAAB//wAAAAAf/8AAAAAP/+AAAAAH//gAAAAB//wAAAAA//4AAAAAP/8AAAAAP//AAAAAD//wAAAAB//4AAAAAf/8AAAAAH//AAAAAD//gAAAAA//4AAAAA//8AAAAAP//AAAAAD//gAAAAB//wAAAAAf/8AAAAAP/+AAAAAD//gAAAAA//gAAAAA//4AAAAAP/+AAAAAH//AAAAAB//wAAAAAf/4AAAAAf/+AAAAAH/+AAAAAB//gAAAAA//4AAAAAA==' },
  '8': { w: 42, h: 64, b64: 'AAD/wAAAA///AAAA///AAAH///4AAf///+AB/////gB/////gB/////wD/////wH/////4H/////4H/////4f/+Af/+f/+AP/+f/8AP/+f/4AH/+f/4AH/+f/4AH/+f/4AH/+f/4AH/+f/4AH/+f/4AH/+f/4AH/+H/8AP/4H/8AP/4H/+Af/4D/////wD/////wD/////wB/////gAf///+AAP///8AAf///+AB/////gD/////wD/////wD/////4H/////4H//A//+f/8AP/+f/8AP/+f/4AH/+//wAD/+//wAD////gAB////gAB////gAB////gAB////wAD////4AH//f/4AH/+f/4AH/+f/8AP/+f//h//+H/////+H/////4H/////4D/////wD/////wB/////gAf////gAP///8AAP///8AAB///4A' },
  '9': { w: 48, h: 64, b64: 'AAAf/gAAAAf//+AAAAf//+AAAB////gAAH////8AAP////8AAf////+AA//////gB//////wD//////wD//////4H//////4H//wB//+f//gA//+f/+AAf/+f/8AAP/+f/4AAH////4AAH////4AAB////wAAB////gAAB////gAAB////gAAB////wAAB////wAAB////wAAB////4AAD////8AAH//f/8AAH//f/+AAP//f/+AAf/+f//wB//+H//wB//+H//////+H//////4D//////4B//////4A//////wAf/////wAH/////gAH/////gAA////+AAAD///+AAAD///+AAAAA//8AAAAB//4AAAAB//4AAAAB//4AAAAH//gAAAAP//AAAAAP//AAAAAP//AAAAAf/+AAAAB//+AAAAB//4AAAAB//4AAAAD//wAAAAH//gAAAAH//gAAAAH//gAAAAf/+AAAAA//+AAAAA//+AAAAA//8AAA' },
}

// ── Template decoding ──

interface DigitTemplate {
  data: Float32Array
  w: number
  h: number
}

let _digitTemplates: Record<string, DigitTemplate> | null = null

function decodeDigitTemplate(entry: { w: number; h: number; b64: string }): DigitTemplate {
  const { w, h, b64 } = entry
  const totalPixels = w * h
  const binaryStr = atob(b64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i)
  }
  const data = new Float32Array(totalPixels)
  for (let i = 0; i < totalPixels; i++) {
    const byteIdx = Math.floor(i / 8)
    const bitIdx = 7 - (i % 8)
    data[i] = (bytes[byteIdx] >> bitIdx) & 1
  }
  return { data, w, h }
}

function getDigitTemplates(): Record<string, DigitTemplate> {
  if (!_digitTemplates) {
    _digitTemplates = {}
    for (const [ch, entry] of Object.entries(DIGIT_TEMPLATES)) {
      _digitTemplates[ch] = decodeDigitTemplate(entry)
    }
  }
  return _digitTemplates
}

// ── Cell extraction + binarization ──

function getScoreboardCell(
  data: Uint8ClampedArray,
  imgW: number,
  colStartX: number,
  colEndX: number,
  rowTopY: number,
  rowBottomY: number,
  threshold: number,
): { binary: Uint8Array; w: number; h: number } {
  const cellYStart = rowTopY + SB_CELL_Y_START
  const cellYEnd = Math.min(rowTopY + SB_CELL_Y_END, rowBottomY)
  const cellW = colEndX - colStartX
  const cellH = cellYEnd - cellYStart
  const binary = new Uint8Array(cellW * cellH)

  for (let y = 0; y < cellH; y++) {
    for (let x = 0; x < cellW; x++) {
      const srcIdx = ((cellYStart + y) * imgW + (colStartX + x)) * 4
      const gray = 0.299 * data[srcIdx] + 0.587 * data[srcIdx + 1] + 0.114 * data[srcIdx + 2]
      binary[y * cellW + x] = gray > threshold ? 255 : 0
    }
  }

  return { binary, w: cellW, h: cellH }
}

// ── Connected components (flood-fill) ──

function sbLabelCC(
  binary: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; count: number } {
  const labels = new Int32Array(width * height)
  let nextLabel = 1

  function flood(startX: number, startY: number, label: number) {
    const stack: Array<[number, number]> = [[startX, startY]]
    while (stack.length > 0) {
      const [cx, cy] = stack.pop()!
      const idx = cy * width + cx
      if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue
      if (labels[idx] !== 0 || binary[idx] === 0) continue
      labels[idx] = label
      stack.push([cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1])
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (binary[idx] > 0 && labels[idx] === 0) {
        flood(x, y, nextLabel)
        nextLabel++
      }
    }
  }

  return { labels, count: nextLabel - 1 }
}

// ── Segmentation ──

interface SbSegment {
  x_min: number
  x_max: number
  y_min: number
  y_max: number
  area: number
  width: number
  height: number
  x_center: number
  type: 'digit' | 'small'
}

function sbSegment(binary: Uint8Array, width: number, height: number): SbSegment[] {
  const { labels, count } = sbLabelCC(binary, width, height)
  const segments: SbSegment[] = []

  for (let i = 1; i <= count; i++) {
    let xMin = width, xMax = 0, yMin = height, yMax = 0, area = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (labels[y * width + x] === i) {
          if (x < xMin) xMin = x
          if (x > xMax) xMax = x
          if (y < yMin) yMin = y
          if (y > yMax) yMax = y
          area++
        }
      }
    }
    if (area >= SB_MIN_BLOB_AREA) {
      segments.push({
        x_min: xMin, x_max: xMax, y_min: yMin, y_max: yMax,
        area,
        width: xMax - xMin + 1,
        height: yMax - yMin + 1,
        x_center: (xMin + xMax) / 2,
        type: area >= 80 && (yMax - yMin + 1) >= 10 ? 'digit' : 'small',
      })
    }
  }

  segments.sort((a, b) => a.x_min - b.x_min)
  return segments
}

// ── NCC template matching ──

function sbResizeBinary(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float32Array {
  const dst = new Float32Array(dstW * dstH)
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.min(Math.floor(x * srcW / dstW), srcW - 1)
      const srcY = Math.min(Math.floor(y * srcH / dstH), srcH - 1)
      dst[y * dstW + x] = src[srcY * srcW + srcX] > 128 ? 1.0 : 0.0
    }
  }
  return dst
}

function sbResizeFloat(
  src: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float32Array {
  const dst = new Float32Array(dstW * dstH)
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.min(Math.floor(x * srcW / dstW), srcW - 1)
      const srcY = Math.min(Math.floor(y * srcH / dstH), srcH - 1)
      dst[y * dstW + x] = src[srcY * srcW + srcX]
    }
  }
  return dst
}

function sbMatchBlob(
  binary: Uint8Array,
  binaryW: number,
  seg: SbSegment,
  templates: Record<string, DigitTemplate>,
): { char: string; score: number } {
  if (seg.type === 'small') return { char: 'SEP', score: 0.95 }

  const blobW = seg.width
  const blobH = seg.height
  if (blobW === 0 || blobH === 0) return { char: '?', score: 0 }

  const blob = new Uint8Array(blobW * blobH)
  for (let y = 0; y < blobH; y++) {
    for (let x = 0; x < blobW; x++) {
      blob[y * blobW + x] = binary[(seg.y_min + y) * binaryW + (seg.x_min + x)]
    }
  }

  const scale = SB_NORM_H / blobH
  const newW = Math.max(1, Math.round(blobW * scale))
  const blobNorm = sbResizeBinary(blob, blobW, blobH, newW, SB_NORM_H)

  let bestChar = '?'
  let bestScore = -1
  let secondChar = '?'
  let secondScore = -1

  for (const [ch, tmpl] of Object.entries(templates)) {
    const tmplW = tmpl.w
    const widthRatio = newW / tmplW
    if (widthRatio < 0.4 || widthRatio > 2.5) continue

    const blobMatched = sbResizeFloat(blobNorm, newW, SB_NORM_H, tmplW, SB_NORM_H)

    let ab = 0, aa = 0, bb = 0
    for (let i = 0; i < tmplW * SB_NORM_H; i++) {
      ab += blobMatched[i] * tmpl.data[i]
      aa += blobMatched[i] * blobMatched[i]
      bb += tmpl.data[i] * tmpl.data[i]
    }
    const ncc = (aa > 0 && bb > 0) ? ab / Math.sqrt(aa * bb) : 0

    if (ncc > bestScore) {
      secondChar = bestChar
      secondScore = bestScore
      bestScore = ncc
      bestChar = ch
    } else if (ncc > secondScore) {
      secondScore = ncc
      secondChar = ch
    }
  }

  // Structural disambiguation for 2 vs 9
  const confusable29 = (bestChar === '2' && secondChar === '9') || (bestChar === '9' && secondChar === '2')
  if (confusable29 && bestScore - secondScore < 0.15) {
    const bottomZone = Math.floor(blobH * 0.2)
    let bottomWhite = 0, bottomTotal = 0
    for (let y = blobH - bottomZone; y < blobH; y++) {
      for (let x = 0; x < blobW; x++) {
        if (blob[y * blobW + x] > 128) bottomWhite++
        bottomTotal++
      }
    }
    const bottomDensity = bottomTotal > 0 ? bottomWhite / bottomTotal : 0
    const structuralCall = bottomDensity > 0.40 ? '2' : '9'
    if (structuralCall !== bestChar) {
      console.log(`[sb-stats] 2/9 disambiguation: NCC=${bestChar}, density=${bottomDensity.toFixed(3)} → ${structuralCall}`)
      bestChar = structuralCall
      bestScore = Math.max(bestScore, secondScore)
    }
  }

  return { char: bestChar, score: bestScore }
}

// ── Value reading (single threshold) ──

function sbReadValue(binary: Uint8Array, width: number, height: number): { value: string; confidence: number } {
  const templates = getDigitTemplates()
  const segs = sbSegment(binary, width, height)

  if (segs.length === 0) return { value: '0', confidence: 1.0 }

  const chars: string[] = []
  const scores: number[] = []
  for (const seg of segs) {
    const { char, score } = sbMatchBlob(binary, width, seg, templates)
    chars.push(char)
    scores.push(score)
  }

  // Post-process: SEP → comma or period (3-digit rule)
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === 'SEP') {
      let digitsAfter = 0
      for (let j = i + 1; j < chars.length; j++) {
        if ('0123456789'.includes(chars[j])) digitsAfter++
        else break
      }
      result.push(digitsAfter === 3 ? ',' : '.')
    } else {
      result.push(chars[i])
    }
  }

  return {
    value: result.join(''),
    confidence: scores.length > 0 ? Math.min(...scores) : 0,
  }
}

// ── Multi-threshold value reading ──

function sbReadCellMultiThreshold(
  data: Uint8ClampedArray,
  imgW: number,
  colStartX: number,
  colEndX: number,
  rowTopY: number,
  rowBottomY: number,
): { value: string; confidence: number; voteSplit: boolean } {
  // 6f: `voteSplit` is true whenever the three thresholds did NOT all agree on
  // the value. When the multi-threshold vote falls back to character-level
  // majority (or most-common-value) reconciliation, the read is inherently less
  // certain — this is the Test-4 885/855 class. The flag is consumed by the 6f
  // confirmation layer (tier 2: scoreboard digit) and changes NO read behaviour.
  const results = SB_THRESHOLDS.map(thresh => {
    const { binary, w, h } = getScoreboardCell(data, imgW, colStartX, colEndX, rowTopY, rowBottomY, thresh)
    return sbReadValue(binary, w, h)
  })

  const values = results.map(r => r.value)
  const confs = results.map(r => r.confidence)

  if (values[0] === values[1] && values[1] === values[2]) {
    return { ...results[0], voteSplit: false }
  }

  console.log(`[sb-stats] Multi-threshold instability: ${SB_THRESHOLDS.map((t, i) => `t${t}="${values[i]}"`).join(', ')}`)

  // Character-by-character majority vote if same length
  if (values[0].length === values[1].length && values[1].length === values[2].length) {
    const voted: string[] = []
    for (let i = 0; i < values[0].length; i++) {
      const c0 = values[0][i], c1 = values[1][i], c2 = values[2][i]
      if (c0 === c1 || c0 === c2) voted.push(c0)
      else if (c1 === c2) voted.push(c1)
      else {
        const bestIdx = confs.indexOf(Math.max(...confs))
        voted.push(values[bestIdx][i])
      }
    }
    const votedValue = voted.join('')
    console.log(`[sb-stats] Majority vote: "${votedValue}"`)
    return { value: votedValue, confidence: Math.max(...confs), voteSplit: true }
  }

  // Different lengths — pick the most common value
  const countMap = new Map<string, number>()
  for (const v of values) countMap.set(v, (countMap.get(v) || 0) + 1)
  let bestValue = values[0], bestCount = 0
  for (const [v, count] of countMap) {
    if (count > bestCount) { bestCount = count; bestValue = v }
  }
  const matchIdx = values.indexOf(bestValue)
  console.log(`[sb-stats] Length mismatch, picked most common: "${bestValue}"`)
  return { value: bestValue, confidence: confs[matchIdx], voteSplit: true }
}

// ── Main extraction function ──

export interface SbCellConfidence {
  slot: number
  team: 'ally' | 'enemy'
  field: 'eliminations' | 'assists' | 'deaths' | 'damage' | 'healing' | 'mitigation'
  value: number | null
  confidence: number
  voteSplit: boolean
}

export async function extractStats(
  img: HTMLImageElement,
  heroes: ScoreboardHeroIdentification[],
  roles: ScoreboardRoleClassification[],
  players: ScoreboardPlayerLabel[],
  detection: ScoreboardDetectionResult,
  // 6f (optional, non-breaking): pass an array to receive per-cell confidence +
  // vote-split flags alongside the normal stats. Existing callers omit this and
  // are completely unaffected.
  cellConfidenceOut?: SbCellConfidence[],
): Promise<ScoreboardPlayerStats[]> {
  const grid = detection.grid
  if (!grid) {
    console.warn('[sb-stats] No grid available — returning empty stats')
    return players.map(p => ({
      slot: p.slot, team: p.team, heroName: p.heroName,
      role: roles.find(r => r.slot === p.slot)?.role ?? null,
      isUser: p.isUser,
      eliminations: null, assists: null, deaths: null,
      damage: null, healing: null, mitigation: null,
    }))
  }

  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  canvas.getContext('2d')!.drawImage(img, 0, 0)
  const imageData = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
  const { data, width: imgW } = imageData

  console.log(`[sb-stats] Extracting stats for ${grid.rows.length} rows...`)

  const results: ScoreboardPlayerStats[] = []

  for (const row of grid.rows) {
    const hero = heroes.find(h => h.slot === row.slot)
    const role = roles.find(r => r.slot === row.slot)
    const player = players.find(p => p.slot === row.slot)

    const stats: ScoreboardPlayerStats = {
      slot: row.slot,
      team: row.team,
      heroName: hero?.heroName ?? null,
      role: role?.role ?? null,
      isUser: player?.isUser ?? false,
      eliminations: null,
      assists: null,
      deaths: null,
      damage: null,
      healing: null,
      mitigation: null,
    }

    for (const { key, field } of STAT_COL_KEYS) {
      const col = grid.columns[key]
      if (!('startX' in col)) continue

      const { value, confidence, voteSplit } = sbReadCellMultiThreshold(
        data, imgW,
        col.startX, col.endX,
        row.topY, row.bottomY,
      )

      const cleaned = value.replace(/,/g, '')
      const num = parseInt(cleaned, 10)

      if (!isNaN(num)) {
        (stats as any)[field] = num
      }

      if (cellConfidenceOut) {
        cellConfidenceOut.push({
          slot: row.slot,
          team: row.team,
          field: field as SbCellConfidence['field'],
          value: isNaN(num) ? null : num,
          confidence,
          voteSplit,
        })
      }

      console.log(`[sb-stats] Slot ${row.slot} ${key}: "${value}" → ${isNaN(num) ? 'null' : num} (conf=${confidence.toFixed(3)}${voteSplit ? ', VOTE-SPLIT' : ''})`)
    }

    results.push(stats)
  }

  return results
}
