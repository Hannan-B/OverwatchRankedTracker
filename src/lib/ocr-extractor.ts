// ============================================================
// OCR EXTRACTOR v2 — Position-based summary page extraction
//
// PS5 summary screenshots are fixed-resolution, so every element
// lives at a known pixel coordinate (measured in summary_page_audit.md,
// reference 3840×2160). This replaces the v1 approach of running
// full-image Tesseract twice and locating values by fuzzy text
// proximity + a 3-layer fallback chain (~400 lines, fragile).
//
// Architecture:
//   - E/A/D stat values → template matching (breakdown-ocr engine).
//     Validated 15/15 across test screenshots at confidence ≥ 0.95.
//   - Map name, result, score, game mode, game length → Tesseract on
//     small, clean, single-purpose crops + regex/fuzzy parsing.
//     (Tesseract is reliable on tight clean crops — the v1 failures
//      came from OCR'ing the entire noisy image, not from Tesseract.)
//
// All coordinates are defined at REF_W × REF_H and scaled to the
// actual image dimensions at runtime, so non-native resolutions
// still work as long as the aspect ratio matches.
// ============================================================

import Tesseract from 'tesseract.js'
import { MAPS } from '@/data/reference'
import { readRegionValueMultiThreshold } from './breakdown-ocr'

// ============================================================
// REFERENCE RESOLUTION + CROP REGIONS
// ============================================================

const REF_W = 3840
const REF_H = 2160

interface Region { x: number; y: number; w: number; h: number }

// Crop boxes at reference resolution. See summary_page_audit.md.
const REGIONS: Record<string, Region> = {
  // Right panel — text fields (Tesseract)
  mapName:    { x: 2580, y: 379,  w: 470, h: 51 },   // map name header
  result:     { x: 2580, y: 1225, w: 470, h: 95 },   // VICTORY / DEFEAT / DRAW
  scoreLine:  { x: 2580, y: 1345, w: 470, h: 36 },   // "· FINAL SCORE: X VS Y"
  dateLine:   { x: 2580, y: 1405, w: 470, h: 38 },   // "· DATE: MM/DD/YY - HH:MM" (measured: text band y1408-1434)
  modeLine:   { x: 2580, y: 1461, w: 470, h: 36 },   // "· GAME MODE: HYBRID"
  lengthLine: { x: 2580, y: 1519, w: 470, h: 36 },   // "· GAME LENGTH: MM:SS"

  // Middle column — stat value digits (template matching).
  // Crop excludes the icon (left of x≈1720) and the label band below.
  // Height 76 captures the digit in both layouts (with/without avg-per-10 line).
  elimDigits:   { x: 1750, y: 642,  w: 170, h: 76 },
  assistDigits: { x: 1750, y: 1124, w: 170, h: 76 },
  deathDigits:  { x: 1750, y: 1606, w: 170, h: 76 },
}

function scaleRegion(r: Region, imgW: number, imgH: number): Region {
  const sx = imgW / REF_W
  const sy = imgH / REF_H
  return {
    x: Math.round(r.x * sx),
    y: Math.round(r.y * sy),
    w: Math.round(r.w * sx),
    h: Math.round(r.h * sy),
  }
}

// ============================================================
// TESSERACT WORKER
// ============================================================

let worker: Tesseract.Worker | null = null

async function getWorker(): Promise<Tesseract.Worker> {
  if (!worker) {
    worker = await Tesseract.createWorker('eng')
  }
  return worker
}

export async function terminateOcr() {
  if (worker) {
    await worker.terminate()
    worker = null
  }
}

// ============================================================
// CROP + OCR HELPER
// Crops a region, scales it up for OCR clarity, runs Tesseract.
// ============================================================

async function ocrRegion(
  img: HTMLImageElement,
  region: Region,
  scale: number = 3
): Promise<string> {
  const r = scaleRegion(region, img.naturalWidth, img.naturalHeight)

  const cropCanvas = document.createElement('canvas')
  cropCanvas.width = r.w
  cropCanvas.height = r.h
  const cropCtx = cropCanvas.getContext('2d')!
  cropCtx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)

  // Scale up for better OCR on small text
  const scaledCanvas = document.createElement('canvas')
  scaledCanvas.width = r.w * scale
  scaledCanvas.height = r.h * scale
  const scaledCtx = scaledCanvas.getContext('2d')!
  scaledCtx.imageSmoothingEnabled = true
  scaledCtx.drawImage(cropCanvas, 0, 0, scaledCanvas.width, scaledCanvas.height)

  const ocr = await getWorker()
  const result = await ocr.recognize(scaledCanvas)
  return result.data.text.trim()
}

// ============================================================
// RESULT TYPE
// ============================================================

export interface SummaryOcrResult {
  mapName: string | null
  result: 'victory' | 'defeat' | 'draw' | null
  score: string | null
  gameLengthText: string | null
  gameLengthSeconds: number | null
  // Real match time, parsed from the summary screenshot's "DATE: MM/DD/YY - HH:MM"
  // line. The game displays American MM/DD/YY; we parse that and build a proper
  // Date. null if the date couldn't be read (caller falls back to process time).
  matchTimestamp: Date | null
  matchDateText: string | null   // raw OCR'd date text, for debug/verification
  eliminations: number | null
  assists: number | null
  deaths: number | null
  heroNames: string[]
  raw: Record<string, string>
}

// ============================================================
// MAIN EXPORT
// ============================================================

export async function ocrSummaryPage(img: HTMLImageElement): Promise<SummaryOcrResult> {
  const result: SummaryOcrResult = {
    mapName: null, result: null, score: null,
    gameLengthText: null, gameLengthSeconds: null,
    matchTimestamp: null, matchDateText: null,
    eliminations: null, assists: null, deaths: null,
    heroNames: [], raw: {},
  }

  try {
    // --- Full-image pixel data (for template matching) ---
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const data = imageData.data

    // =========================================================
    // E / A / D — TEMPLATE MATCHING
    // =========================================================
    result.eliminations = extractStatValue(data, canvas.width, canvas.height, 'elimDigits')
    result.assists = extractStatValue(data, canvas.width, canvas.height, 'assistDigits')
    result.deaths = extractStatValue(data, canvas.width, canvas.height, 'deathDigits')

    result.raw.eadMethod = 'template-matching'
    console.log('[ocr-extractor] E/A/D:', {
      eliminations: result.eliminations,
      assists: result.assists,
      deaths: result.deaths,
    })

    // =========================================================
    // MAP NAME — Tesseract + fuzzy match
    // =========================================================
    const mapText = await ocrRegion(img, REGIONS.mapName)
    result.raw.mapText = mapText
    result.mapName = findMapName(mapText.toUpperCase())
    console.log(`[ocr-extractor] Map: "${mapText}" → ${result.mapName}`)

    // =========================================================
    // RESULT — Tesseract keyword check (score-based fallback below)
    // =========================================================
    const resultText = (await ocrRegion(img, REGIONS.result)).toUpperCase()
    result.raw.resultText = resultText
    if (resultText.includes('VICTORY') || resultText.includes('VICT')) {
      result.result = 'victory'
    } else if (resultText.includes('DEFEAT') || resultText.includes('DEFE')) {
      result.result = 'defeat'
    } else if (resultText.includes('DRAW')) {
      result.result = 'draw'
    }

    // =========================================================
    // SCORE — Tesseract + regex ("FINAL SCORE: X VS Y")
    // =========================================================
    const scoreText = (await ocrRegion(img, REGIONS.scoreLine)).toUpperCase()
    result.raw.scoreText = scoreText
    // Strict match first (never alters a clean read).
    let scoreMatch = scoreText.match(/(\d)\s*VS\s*(\d)/)
    if (!scoreMatch) {
      // Fallback: Tesseract sometimes reads a score digit as a letter glyph —
      // most commonly a leading 0 as "O" (e.g. "0 VS 3" → "OVS 3"), and the
      // other standard digit/letter confusions. Normalize ONLY the score line
      // (single digits flanking "VS"), then retry. Scoped here so it can never
      // affect map names, modes, or other text.
      const normalizedScore = normalizeScoreDigits(scoreText)
      scoreMatch = normalizedScore.match(/(\d)\s*VS\s*(\d)/)
      if (scoreMatch) result.raw.scoreNormalized = normalizedScore
    }
    if (scoreMatch) {
      result.score = `${scoreMatch[1]}-${scoreMatch[2]}`

      // Score-based result fallback (if keyword detection failed)
      if (result.result === null) {
        const a = parseInt(scoreMatch[1])
        const b = parseInt(scoreMatch[2])
        result.result = a > b ? 'victory' : a < b ? 'defeat' : 'draw'
        result.raw.resultSource = 'score-derived'
      }
    }
    console.log(`[ocr-extractor] Score: "${scoreText}" → ${result.score}`)

    // =========================================================
    // GAME MODE — Tesseract + keyword match
    // =========================================================
    const modeText = (await ocrRegion(img, REGIONS.modeLine)).toUpperCase()
    result.raw.modeText = modeText
    const MODES = ['CONTROL', 'ESCORT', 'HYBRID', 'PUSH', 'FLASHPOINT', 'CLASH']
    for (const mode of MODES) {
      if (modeText.includes(mode)) {
        result.raw.gameMode = mode.toLowerCase()
        break
      }
    }

    // =========================================================
    // GAME LENGTH — Tesseract + regex ("GAME LENGTH: MM:SS")
    // =========================================================
    const lengthText = await ocrRegion(img, REGIONS.lengthLine)
    result.raw.lengthText = lengthText
    const timeMatch = lengthText.match(/(\d{1,2}):(\d{2})/)
    if (timeMatch) {
      const min = parseInt(timeMatch[1])
      const sec = parseInt(timeMatch[2])
      result.gameLengthText = `${min}:${sec.toString().padStart(2, '0')}`
      result.gameLengthSeconds = min * 60 + sec
    }
    console.log(`[ocr-extractor] Length: "${lengthText}" → ${result.gameLengthText}`)

    // =========================================================
    // MATCH DATE/TIME — Tesseract + regex ("DATE: MM/DD/YY - HH:MM")
    // ---------------------------------------------------------
    // The game shows AMERICAN MM/DD/YY. We parse those parts and build a
    // proper Date (stored as a real timestamp; British DD-MM-YYYY is a
    // DISPLAY concern handled in the UI, not here).
    // Verified against Test_1/2/7 summary screenshots: reads cleanly.
    // Best-effort: if it can't parse, matchTimestamp stays null and the
    // caller falls back to process time. A bad read NEVER blocks anything.
    // =========================================================
    const dateText = await ocrRegion(img, REGIONS.dateLine)
    result.raw.dateText = dateText
    result.matchDateText = dateText
    // Match "MM/DD/YY - HH:MM" anywhere in the string (ignores the "· DATE:" label).
    const dateMatch = dateText.match(/(\d{2})\/(\d{2})\/(\d{2})\s*-\s*(\d{1,2}):(\d{2})/)
    if (dateMatch) {
      const mm = parseInt(dateMatch[1], 10)   // American: month first
      const dd = parseInt(dateMatch[2], 10)   // then day
      const yy = parseInt(dateMatch[3], 10)   // 2-digit year
      const hh = parseInt(dateMatch[4], 10)
      const min = parseInt(dateMatch[5], 10)
      // Sanity-bound every part before trusting it (guards against OCR noise).
      const valid =
        mm >= 1 && mm <= 12 &&
        dd >= 1 && dd <= 31 &&
        hh >= 0 && hh <= 23 &&
        min >= 0 && min <= 59
      if (valid) {
        const fullYear = 2000 + yy
        // Construct in local time (matches how the player reads the clock).
        // Month is 0-indexed in JS Date.
        const d = new Date(fullYear, mm - 1, dd, hh, min, 0, 0)
        if (!isNaN(d.getTime())) {
          result.matchTimestamp = d
          result.raw.matchTimestampISO = d.toISOString()
        }
      }
      if (!result.matchTimestamp) {
        console.warn(`[ocr-extractor] Date parsed but failed validation: "${dateText}"`)
      }
    } else {
      console.warn(`[ocr-extractor] Date not matched in: "${dateText}" (will fall back to process time)`)
    }
    console.log(`[ocr-extractor] Date: "${dateText}" → ${result.matchTimestamp?.toISOString() ?? 'null (fallback)'}`)

    // =========================================================
    // HERO NAMES
    // Hero identification is handled by portrait matching in
    // image-processor.ts (step 6a-iii), not by OCR here. The
    // portrait pipeline is far more reliable than reading the
    // small italic hero-name text. Left empty by design.
    // =========================================================
    result.heroNames = []

  } catch (e) {
    console.warn('[ocr-extractor] Summary extraction failed:', e)
  }

  return result
}

// ============================================================
// STAT VALUE EXTRACTION — Template matching
// ============================================================

function extractStatValue(
  data: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  regionKey: 'elimDigits' | 'assistDigits' | 'deathDigits'
): number | null {
  const r = scaleRegion(REGIONS[regionKey], imgW, imgH)
  const { value, confidence } = readRegionValueMultiThreshold(
    data, imgW, r.x, r.y, r.w, r.h
  )

  // Strip any stray non-digit characters the matcher may emit
  const digits = value.replace(/[^0-9]/g, '')
  if (digits.length === 0) {
    console.warn(`[ocr-extractor] ${regionKey}: no digits read (raw="${value}")`)
    return null
  }

  const num = parseInt(digits, 10)
  // Sanity bound: summary E/A/D values are realistically 0–150
  if (num < 0 || num > 150) {
    console.warn(`[ocr-extractor] ${regionKey}: value ${num} out of range (conf=${confidence.toFixed(3)})`)
    return null
  }

  return num
}

// ============================================================
// SCORE DIGIT NORMALIZATION
// ------------------------------------------------------------
// Tesseract occasionally reads a score digit as a visually-similar letter,
// most often a leading 0 → "O" (seen: "FINAL SCORE: 0 VS 3" → "OVS 3"). This
// maps the standard digit/letter look-alikes back to digits so the
// "(d) VS (d)" regex can recover. Applied ONLY as a fallback on the score
// line, and the literal "VS" separator is protected so its own letters are
// never converted.
// ============================================================

const SCORE_GLYPH_TO_DIGIT: Record<string, string> = {
  O: '0', Q: '0', D: '0',
  I: '1', L: '1', '|': '1',
  Z: '2',
  S: '5',
  G: '6',
  T: '7',
  B: '8',
}

function normalizeScoreDigits(scoreText: string): string {
  // Protect the "VS" token from substitution (S→5 would otherwise corrupt it),
  // normalize the remaining characters, then restore "VS".
  const VS_PLACEHOLDER = '\u0001'
  const protectedText = scoreText.replace(/VS/g, VS_PLACEHOLDER)
  const normalized = protectedText.replace(
    /[OQDILZSGTB|]/g,
    (ch) => SCORE_GLYPH_TO_DIGIT[ch] ?? ch,
  )
  return normalized.replace(new RegExp(VS_PLACEHOLDER, 'g'), 'VS')
}

// ============================================================
// MAP NAME MATCHING — fuzzy match against known maps
// ============================================================

export function findMapName(upperText: string): string | null {
  // Exact substring match against the canonical map list
  for (const map of MAPS) {
    if (upperText.includes(map.name.toUpperCase())) return map.name
  }

  // Partial / OCR-tolerant keyword match
  const partialMatches: Record<string, string> = {
    'ANTARCTIC': 'Antarctic Peninsula',
    'CIRCUIT': 'Circuit Royal',
    'JUNKERTOWN': 'Junkertown',
    'SHAMBALI': 'Shambali Monastery',
    'WATCHPOINT': 'Watchpoint: Gibraltar',
    'GIBRALTAR': 'Watchpoint: Gibraltar',
    'LIJIANG': 'Lijiang Tower',
    'BLIZZARD': 'Blizzard World',
    'EICHENWALDE': 'Eichenwalde',
    'HOLLYWOOD': 'Hollywood',
    "KING'S": "King's Row",
    'KINGS': "King's Row",
    'MIDTOWN': 'Midtown',
    'NUMBANI': 'Numbani',
    'PARAISO': 'Paraíso',
    'PARAÍSO': 'Paraíso',
    'COLOSSEO': 'Colosseo',
    'ESPERANCA': 'Esperança',
    'ESPERANÇA': 'Esperança',
    'QUEEN': 'New Queen Street',
    'RUNASAPI': 'Runasapi',
    'JUNK CITY': 'New Junk City',
    'SURAVASA': 'Suravasa',
    'AATLIS': 'Aatlis',
    'DORADO': 'Dorado',
    'HAVANA': 'Havana',
    'RIALTO': 'Rialto',
    'ROUTE 66': 'Route 66',
    'BUSAN': 'Busan',
    'ILIOS': 'Ilios',
    'NEPAL': 'Nepal',
    'OASIS': 'Oasis',
    'SAMOA': 'Samoa',
  }

  for (const [keyword, mapName] of Object.entries(partialMatches)) {
    if (upperText.includes(keyword)) return mapName
  }

  return null
}
