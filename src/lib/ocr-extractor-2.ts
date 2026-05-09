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

  // Preprocess image for better OCR on monitor photos
  try {
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)

    // Apply preprocessing: grayscale + high contrast
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const data = imageData.data
    for (let i = 0; i < data.length; i += 4) {
      // Convert to grayscale
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      // Increase contrast: stretch values
      const contrasted = Math.min(255, Math.max(0, (gray - 80) * 1.8))
      data[i] = contrasted
      data[i + 1] = contrasted
      data[i + 2] = contrasted
    }
    ctx.putImageData(imageData, 0, 0)

    console.log('Running preprocessed full-image OCR...')
    const ocrResult = await ocr.recognize(canvas)
    const fullText = ocrResult.data.text
    result.raw.fullText = fullText

    console.log('OCR text:', fullText.substring(0, 500))

    // Also run OCR on the original (unprocessed) for comparison
    const origCanvas = document.createElement('canvas')
    origCanvas.width = img.naturalWidth
    origCanvas.height = img.naturalHeight
    origCanvas.getContext('2d')!.drawImage(img, 0, 0)
    const origResult = await ocr.recognize(origCanvas)
    const origText = origResult.data.text
    result.raw.origText = origText

    console.log('OCR text (original):', origText.substring(0, 500))

    // Combine both texts for best coverage
    const combinedText = fullText + '\n' + origText
    const lines = combinedText.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    const upperText = combinedText.toUpperCase()

    // Debug: log all lines for troubleshooting
    console.log('OCR lines:', lines.map((l, i) => `[${i}] ${l}`).join('\n'))

    // --- MAP NAME ---
    result.mapName = findMapName(upperText)
    if (result.mapName) {
      result.raw.map = result.mapName
    }

    // --- RESULT ---
    // Result is now derived from score in image-processor.ts
    // Keep OCR-based detection as a fallback only
    if (upperText.includes('VICTORY') || upperText.includes('VICT') ||
        upperText.includes('VIGTORY') || upperText.includes('VIOTORY')) {
      result.result = 'victory'
    } else if (upperText.includes('DEFEAT') || upperText.includes('DEF') ||
               upperText.includes('DEFEA') || upperText.includes('QEFEAT') ||
               upperText.includes('DETEAT')) {
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
      const match = combinedText.toUpperCase().match(pattern)
      if (match) {
        result.score = `${match[1]}-${match[2]}`
        break
      }
    }

    // --- GAME LENGTH ---
    const timePatterns = [
      /GAME\s*LENGTH[:\s]*(\d{1,2}):(\d{2})/i,
      /LENGTH[:\s]*(\d{1,2}):(\d{2})/i,
      /(\d{1,2}):(\d{2})\s*\n?\s*(?:GAME|LENGTH)/i,
    ]
    for (const pattern of timePatterns) {
      const match = combinedText.match(pattern)
      if (match) {
        const min = parseInt(match[1])
        const sec = parseInt(match[2])
        result.gameLengthText = `${min}:${sec.toString().padStart(2, '0')}`
        result.gameLengthSeconds = min * 60 + sec
        break
      }
    }

    // --- ELIMINATIONS / ASSISTS / DEATHS ---
    // Strategy: use Tesseract's word-level bounding boxes to find
    // the label text, then OCR just the area above it for the number.
    // The game displays large numbers ABOVE the label text.

    async function extractStatByLabel(
      labelPatterns: string[],
      sourceCanvas: HTMLCanvasElement,
      ocrWords: any[],
    ): Promise<number | null> {
      // Find the label word in Tesseract output
      for (const word of ocrWords) {
        const wordUpper = word.text.toUpperCase()
        const matches = labelPatterns.some(p => wordUpper.includes(p))
        if (!matches) continue
        if (word.confidence < 30) continue // Skip low-confidence matches

        // Found the label — crop the area above it for the number
        const bbox = word.bbox
        const labelWidth = bbox.x1 - bbox.x0
        const labelHeight = bbox.y1 - bbox.y0
        const labelCenterX = (bbox.x0 + bbox.x1) / 2

        // Use a wide crop centered on the label — the number above
        // can be wider than the label text, especially for "DEATH"
        // which is a short word. Use at least 200px or 2x label width.
        const cropWidth = Math.max(200, labelWidth * 2.5)
        const cropX = Math.max(0, labelCenterX - cropWidth / 2)
        const cropY = Math.max(0, bbox.y0 - labelHeight * 3)
        const cropW = Math.min(sourceCanvas.width - cropX, cropWidth)
        const cropH = labelHeight * 3

        console.log(`Crop region for "${labelPatterns[0]}": x=${Math.round(cropX)}, y=${Math.round(cropY)}, w=${Math.round(cropW)}, h=${Math.round(cropH)} (label bbox: ${bbox.x0},${bbox.y0} to ${bbox.x1},${bbox.y1})`)

        if (cropW < 10 || cropH < 10) continue

        // Crop and preprocess just this small region
        const numCanvas = document.createElement('canvas')
        numCanvas.width = Math.round(cropW)
        numCanvas.height = Math.round(cropH)
        const numCtx = numCanvas.getContext('2d')!
        numCtx.drawImage(sourceCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)

        // High contrast preprocessing for number reading
        const numData = numCtx.getImageData(0, 0, numCanvas.width, numCanvas.height)
        const pixels = numData.data
        for (let j = 0; j < pixels.length; j += 4) {
          const gray = 0.299 * pixels[j] + 0.587 * pixels[j + 1] + 0.114 * pixels[j + 2]
          const v = gray > 140 ? 255 : 0 // Binary threshold
          pixels[j] = v; pixels[j + 1] = v; pixels[j + 2] = v
        }
        numCtx.putImageData(numData, 0, 0)

        // Scale up for better OCR on small crops
        const scaledCanvas = document.createElement('canvas')
        scaledCanvas.width = numCanvas.width * 3
        scaledCanvas.height = numCanvas.height * 3
        scaledCanvas.getContext('2d')!.drawImage(numCanvas, 0, 0, scaledCanvas.width, scaledCanvas.height)

        // OCR just this number region
        try {
          const numOcr = await ocr.recognize(scaledCanvas)
          const numText = numOcr.data.text.trim()
          console.log(`Stat OCR for "${labelPatterns[0]}": "${numText}" (from bbox ${bbox.x0},${bbox.y0})`)
          
          // Extract number
          const numMatch = numText.match(/(\d{1,3})/)
          if (numMatch) {
            const num = parseInt(numMatch[1])
            if (num >= 0 && num <= 150) return num
          }
        } catch (e) {
          console.warn('Stat region OCR failed:', e)
        }
      }
      return null
    }

    // Get word-level data from both OCR passes
    const origCanvas2 = document.createElement('canvas')
    origCanvas2.width = img.naturalWidth
    origCanvas2.height = img.naturalHeight
    origCanvas2.getContext('2d')!.drawImage(img, 0, 0)

    const wordResult = await ocr.recognize(origCanvas2)
    const words = wordResult.data.words || []
    console.log(`Found ${words.length} words with bounding boxes`)

    result.eliminations = await extractStatByLabel(['ELIMINATION', 'ELIM'], origCanvas2, words)
    result.assists = await extractStatByLabel(['ASSIST', 'ASSIS'], origCanvas2, words)
    result.deaths = await extractStatByLabel(['DEATH', 'DEAT'], origCanvas2, words)

    // Fallback: check the line-based approach too
    if (result.eliminations === null || result.assists === null || result.deaths === null) {
      const numberedLines = lines.map((line, i) => ({ text: line, upper: line.toUpperCase(), index: i }))

      function findStatInLines(labelPatterns: string[]): number | null {
        for (const nl of numberedLines) {
          if (!labelPatterns.some(p => nl.upper.includes(p))) continue
          // Look at lines above
          for (let offset = 1; offset <= 3; offset++) {
            const prevIdx = nl.index - offset
            if (prevIdx < 0) break
            const prevLine = lines[prevIdx].trim()
            const numMatch = prevLine.match(/^(\d{1,2})$/)
            if (numMatch) return parseInt(numMatch[1])
            const startMatch = prevLine.match(/^(\d{1,2})\s/)
            if (startMatch && parseInt(startMatch[1]) <= 99) return parseInt(startMatch[1])
          }
        }
        return null
      }

      if (result.eliminations === null) result.eliminations = findStatInLines(['ELIMINATION', 'ELIM'])
      if (result.assists === null) result.assists = findStatInLines(['ASSIST', 'ASSIS'])
      if (result.deaths === null) result.deaths = findStatInLines(['DEATH', 'DEAT'])
    }

    console.log('E/A/D extraction:', {
      eliminations: result.eliminations,
      assists: result.assists,
      deaths: result.deaths,
    })

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
