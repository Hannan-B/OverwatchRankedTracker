// ============================================================
// OCR EXTRACTOR — Tesseract.js for text extraction
// Uses full-image OCR then parses the text to find data
// More robust than region-cropping for phone photos of monitors
// ============================================================

import Tesseract from 'tesseract.js'
import { MAPS } from '@/data/reference'

let worker: Tesseract.Worker | null = null

async function getWorker(): Promise<Tesseract.Worker> {
  if (!worker) {
    worker = await Tesseract.createWorker('eng')
  }
  return worker
}

// ============================================================
// TEXT CLEANING
// ============================================================

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// ============================================================
// SUMMARY PAGE OCR
// ============================================================

export interface SummaryOcrResult {
  mapName: string | null
  result: 'victory' | 'defeat' | 'draw' | null
  score: string | null
  gameLengthText: string | null
  gameLengthSeconds: number | null
  eliminations: number | null
  assists: number | null
  deaths: number | null
  heroNames: string[]
  raw: Record<string, string>
}

export async function ocrSummaryPage(img: HTMLImageElement): Promise<SummaryOcrResult> {
  const ocr = await getWorker()

  const result: SummaryOcrResult = {
    mapName: null, result: null, score: null,
    gameLengthText: null, gameLengthSeconds: null,
    eliminations: null, assists: null, deaths: null,
    heroNames: [], raw: {},
  }

  // Do full-image OCR — more robust than region cropping
  // for phone photos that include monitor bezels
  try {
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d')!.drawImage(img, 0, 0)

    console.log('Running full-image OCR...')
    const ocrResult = await ocr.recognize(canvas)
    const fullText = ocrResult.data.text
    result.raw.fullText = fullText

    console.log('OCR text:', fullText.substring(0, 500))

    // Parse the full text for each field
    const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    const upperText = fullText.toUpperCase()

    // --- MAP NAME ---
    result.mapName = findMapName(upperText)
    if (result.mapName) {
      result.raw.map = result.mapName
    }

    // --- RESULT ---
    if (upperText.includes('VICTORY') || upperText.includes('VICT')) {
      result.result = 'victory'
    } else if (upperText.includes('DEFEAT') || upperText.includes('DEF')) {
      result.result = 'defeat'
    } else if (upperText.includes('DRAW')) {
      result.result = 'draw'
    }

    // --- SCORE ---
    // Look for patterns like "1 VS 2", "FINAL SCORE: 1 VS 2", "3-2"
    const scorePatterns = [
      /FINAL\s*SCORE[:\s]*(\d)\s*(?:VS|vs)\s*(\d)/,
      /(\d)\s*(?:VS|vs)\s*(\d)/,
      /SCORE[:\s]*(\d)\s*[-:]\s*(\d)/,
    ]
    for (const pattern of scorePatterns) {
      const match = upperText.match(pattern)
      if (match) {
        result.score = `${match[1]}-${match[2]}`
        break
      }
    }

    // --- GAME LENGTH ---
    // Look for time patterns like "14:07", "GAME LENGTH: 14:07"
    const timePatterns = [
      /GAME\s*LENGTH[:\s]*(\d{1,2}):(\d{2})/i,
      /LENGTH[:\s]*(\d{1,2}):(\d{2})/i,
    ]
    for (const pattern of timePatterns) {
      const match = fullText.match(pattern)
      if (match) {
        const min = parseInt(match[1])
        const sec = parseInt(match[2])
        result.gameLengthText = `${min}:${sec.toString().padStart(2, '0')}`
        result.gameLengthSeconds = min * 60 + sec
        break
      }
    }

    // --- ELIMINATIONS ---
    const elimPatterns = [
      /(\d{1,3})\s*\n?\s*ELIMINATIONS/i,
      /ELIMINATIONS[:\s]*(\d{1,3})/i,
    ]
    for (const pattern of elimPatterns) {
      const match = fullText.match(pattern)
      if (match) {
        result.eliminations = parseInt(match[1])
        break
      }
    }

    // --- ASSISTS ---
    const assistPatterns = [
      /(\d{1,3})\s*\n?\s*ASSISTS?/i,
      /ASSISTS?[:\s]*(\d{1,3})/i,
    ]
    for (const pattern of assistPatterns) {
      const match = fullText.match(pattern)
      if (match) {
        result.assists = parseInt(match[1])
        break
      }
    }

    // --- DEATHS ---
    const deathPatterns = [
      /(\d{1,3})\s*\n?\s*DEATHS/i,
      /DEATHS[:\s]*(\d{1,3})/i,
    ]
    for (const pattern of deathPatterns) {
      const match = fullText.match(pattern)
      if (match) {
        result.deaths = parseInt(match[1])
        break
      }
    }

    // --- HERO NAMES ---
    result.heroNames = findHeroNames(lines)

    // --- GAME MODE ---
    const modePatterns = ['CONTROL', 'ESCORT', 'HYBRID', 'PUSH', 'FLASHPOINT', 'CLASH']
    for (const mode of modePatterns) {
      if (upperText.includes(mode)) {
        result.raw.gameMode = mode.toLowerCase()
        break
      }
    }

  } catch (e) {
    console.warn('Full-image OCR failed:', e)
  }

  return result
}

// ============================================================
// MAP NAME MATCHING
// ============================================================

function findMapName(upperText: string): string | null {
  // Try exact match first (most maps have unique names)
  for (const map of MAPS) {
    const mapUpper = map.name.toUpperCase()
    if (upperText.includes(mapUpper)) return map.name
  }

  // Try partial matches for longer map names
  // (OCR might split "ANTARCTIC PENINSULA" across lines)
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
    'COLOSSEO': 'Colosseo',
    'ESPERANCA': 'Esperança',
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

// ============================================================
// HERO NAME MATCHING
// ============================================================

const HERO_NAMES_UPPER: Record<string, string> = {
  'ANA': 'Ana', 'ANRAN': 'Anran', 'ASHE': 'Ashe',
  'BAPTISTE': 'Baptiste', 'BASTION': 'Bastion', 'BRIGITTE': 'Brigitte',
  'CASSIDY': 'Cassidy', 'D.VA': 'D.Va', 'DVA': 'D.Va',
  'DOMINA': 'Domina', 'DOOMFIST': 'Doomfist', 'ECHO': 'Echo',
  'EMRE': 'Emre', 'FREJA': 'Freja', 'GENJI': 'Genji',
  'HANZO': 'Hanzo', 'HAZARD': 'Hazard', 'ILLARI': 'Illari',
  'JETPACK CAT': 'Jetpack Cat', 'JUNKER QUEEN': 'Junker Queen',
  'JUNKRAT': 'Junkrat', 'JUNO': 'Juno', 'KIRIKO': 'Kiriko',
  'LIFEWEAVER': 'Lifeweaver', 'LUCIO': 'Lúcio',
  'MAUGA': 'Mauga', 'MEI': 'Mei', 'MERCY': 'Mercy',
  'MIZUKI': 'Mizuki', 'MOIRA': 'Moira', 'ORISA': 'Orisa',
  'PHARAH': 'Pharah', 'RAMATTRA': 'Ramattra', 'REAPER': 'Reaper',
  'REINHARDT': 'Reinhardt', 'ROADHOG': 'Roadhog',
  'SIERRA': 'Sierra', 'SIGMA': 'Sigma', 'SOJOURN': 'Sojourn',
  'SOLDIER: 76': 'Soldier: 76', 'SOLDIER 76': 'Soldier: 76',
  'SOMBRA': 'Sombra', 'SYMMETRA': 'Symmetra',
  'TORBJORN': 'Torbjörn', 'TRACER': 'Tracer',
  'VENDETTA': 'Vendetta', 'VENTURE': 'Venture',
  'WIDOWMAKER': 'Widowmaker', 'WINSTON': 'Winston',
  'WRECKING BALL': 'Wrecking Ball', 'WUYANG': 'Wuyang',
  'ZARYA': 'Zarya', 'ZENYATTA': 'Zenyatta',
}

function findHeroNames(lines: string[]): string[] {
  const found: string[] = []

  for (const line of lines) {
    const upper = line.toUpperCase().trim()

    // Skip very short lines or lines that are clearly stats
    if (upper.length < 3 || upper.length > 20) continue
    if (/^\d+$/.test(upper)) continue // Pure numbers
    if (upper.includes('PLAYED') || upper.includes('PERCENT')) continue
    if (upper.includes('TIME') || upper.includes('AVG')) continue

    // Check against known hero names
    for (const [key, displayName] of Object.entries(HERO_NAMES_UPPER)) {
      if (upper === key || upper.includes(key)) {
        if (!found.includes(displayName)) {
          found.push(displayName)
        }
        break
      }
    }
  }

  return found
}

// ============================================================
// CLEANUP
// ============================================================

export async function terminateOcr() {
  if (worker) {
    await worker.terminate()
    worker = null
  }
}
