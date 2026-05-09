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
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
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

    console.log('OCR lines:', lines.map((l, i) => `[${i}] ${l}`).join('\n'))

    // --- MAP NAME ---
    result.mapName = findMapName(upperText)
    if (result.mapName) {
      result.raw.map = result.mapName
    }

    // --- RESULT (OCR fallback — primary is score-based in image-processor.ts) ---
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

    // =========================================================
    // ELIMINATIONS / ASSISTS / DEATHS — Word-level digit lookup
    // =========================================================
    // Instead of cropping and re-OCR'ing small regions (fragile),
    // we use the word-level data Tesseract already produced from
    // the full-image scans. Both the preprocessed and original passes
    // detect words — we merge them for best coverage. Different
    // preprocessing can detect different digits.

    const preprocessedWords = ocrResult.data.words || []
    const originalWords = origResult.data.words || []
    console.log(`Words from preprocessed: ${preprocessedWords.length}, original: ${originalWords.length}`)

    // Merge words from both passes
    const allWords = [...preprocessedWords, ...originalWords]

    // Step 1: Find stat labels with fuzzy matching
    // Tesseract garbles text (e.g. "ELMINATIONS" for "ELIMINATIONS")
    const statLabels: Record<string, { x0: number; y0: number; x1: number; y1: number } | null> = {
      elim: null, assist: null, death: null,
    }

    for (const word of allWords) {
      const u = word.text.toUpperCase()
      if (word.confidence < 20) continue

      if (!statLabels.elim &&
          (u.includes('ELIMINATION') || u.includes('ELMINATION') ||
           u.includes('LIMINATION') || u.includes('ELIM') ||
           (u.length >= 8 && u.startsWith('EL') && u.includes('NATION')))) {
        statLabels.elim = { ...word.bbox }
        console.log(`Found label "elim": "${word.text}" at (${word.bbox.x0},${word.bbox.y0}) conf=${Math.round(word.confidence)}`)
      }
      if (!statLabels.assist && (u.includes('ASSIST') || u.includes('ASSIS'))) {
        statLabels.assist = { ...word.bbox }
        console.log(`Found label "assist": "${word.text}" at (${word.bbox.x0},${word.bbox.y0}) conf=${Math.round(word.confidence)}`)
      }
      if (!statLabels.death && (u.includes('DEATH') || u.includes('DEAT'))) {
        statLabels.death = { ...word.bbox }
        console.log(`Found label "death": "${word.text}" at (${word.bbox.x0},${word.bbox.y0}) conf=${Math.round(word.confidence)}`)
      }
    }

    const foundLabelNames = Object.entries(statLabels).filter(([, v]) => v !== null).map(([k]) => k)
    console.log(`Labels found: ${foundLabelNames.join(', ') || 'none'}`)

    // Step 2: Collect digit candidates
    interface DigitCandidate {
      value: number
      x0: number; y0: number; x1: number; y1: number
      yCenter: number
    }
    const digitCandidates: DigitCandidate[] = []

    const pureDigitWords = allWords.filter((w: any) => {
      const clean = w.text.replace(/[^0-9]/g, '')
      return clean.length >= 1 && clean.length <= 3 && clean.length === w.text.trim().length
    })

    for (const w of pureDigitWords) {
      const val = parseInt(w.text.trim())
      if (val >= 0 && val <= 150) {
        digitCandidates.push({
          value: val,
          x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1,
          yCenter: (w.bbox.y0 + w.bbox.y1) / 2,
        })
      }
    }

    // Combine adjacent single-digit words (e.g. "1" + "4" → 14)
    // Track which singles were combined so we can remove them
    const combinedIndices = new Set<number>()
    const singleDigits = pureDigitWords.filter((w: any) => w.text.trim().length === 1)
    for (let i = 0; i < singleDigits.length; i++) {
      for (let j = i + 1; j < singleDigits.length; j++) {
        const a = singleDigits[i]
        const b = singleDigits[j]
        if (Math.abs(a.bbox.y0 - b.bbox.y0) > 30) continue
        const left = a.bbox.x0 < b.bbox.x0 ? a : b
        const right = a.bbox.x0 < b.bbox.x0 ? b : a
        const gap = right.bbox.x0 - left.bbox.x1
        if (gap < -10 || gap > 100) continue
        const combined = parseInt(left.text.trim() + right.text.trim())
        if (combined >= 0 && combined <= 150) {
          digitCandidates.push({
            value: combined,
            x0: left.bbox.x0, y0: Math.min(a.bbox.y0, b.bbox.y0),
            x1: right.bbox.x1, y1: Math.max(a.bbox.y1, b.bbox.y1),
            yCenter: (Math.min(a.bbox.y0, b.bbox.y0) + Math.max(a.bbox.y1, b.bbox.y1)) / 2,
          })
          // Mark the individual digits for removal
          combinedIndices.add(i)
          combinedIndices.add(j)
        }
      }
    }

    // Remove single-digit candidates that were combined into multi-digit ones
    // to prevent "1" from being matched when "14" is the real value
    const singleDigitPositions = Array.from(combinedIndices).map(idx => singleDigits[idx])
    const filteredCandidates = digitCandidates.filter(d => {
      if (d.value >= 10) return true // Keep multi-digit candidates
      // Check if this single digit was part of a combination
      return !singleDigitPositions.some((s: any) =>
        Math.abs(d.x0 - s.bbox.x0) < 5 && Math.abs(d.y0 - s.bbox.y0) < 5
      )
    })

    console.log(`Digit candidates (${filteredCandidates.length}):`,
      filteredCandidates.map(d => `${d.value} at (${d.x0},${d.y0})`).join(', ')
    )

    // Step 3: Match digits to labels by position
    function findStatNumber(
      label: { x0: number; y0: number; x1: number; y1: number },
      statName: string,
    ): number | null {
      let bestMatch: DigitCandidate | null = null
      let bestDistance = Infinity

      for (const digit of filteredCandidates) {
        // Must be above the label (allow 20px overlap for touching text)
        if (digit.y1 > label.y0 + 20) continue
        // Must not be too far above
        if (label.y0 - digit.y0 > 400) continue
        // Use digit's center X for horizontal check — Tesseract sometimes
        // gives abnormally wide bboxes (e.g. "24" at 442px wide)
        const digitCenterX = (digit.x0 + digit.x1) / 2
        if (Math.abs(digitCenterX - label.x0) > 250) continue

        const dist = label.y0 - digit.yCenter
        if (dist < bestDistance) {
          bestDistance = dist
          bestMatch = digit
        }
      }

      if (bestMatch) {
        console.log(`Matched ${statName}: ${bestMatch.value} at (${bestMatch.x0},${bestMatch.y0}), ${Math.round(bestDistance)}px above label`)
      } else {
        console.log(`No digit match found for ${statName}`)
      }
      return bestMatch?.value ?? null
    }

    if (statLabels.elim) result.eliminations = findStatNumber(statLabels.elim, 'eliminations')
    if (statLabels.assist) result.assists = findStatNumber(statLabels.assist, 'assists')
    if (statLabels.death) result.deaths = findStatNumber(statLabels.death, 'deaths')

    // Estimate missing label positions from found labels
    if (!statLabels.elim && statLabels.assist) {
      const gap = statLabels.death ? statLabels.death.y0 - statLabels.assist.y0 : 620
      const est = { x0: statLabels.assist.x0, y0: statLabels.assist.y0 - gap, x1: statLabels.assist.x1, y1: statLabels.assist.y1 - gap }
      console.log(`Estimating elim label at y=${est.y0}`)
      if (result.eliminations === null) result.eliminations = findStatNumber(est, 'eliminations (estimated)')
    }
    if (!statLabels.death && statLabels.assist) {
      const gap = statLabels.elim ? statLabels.assist.y0 - statLabels.elim.y0 : 620
      const est = { x0: statLabels.assist.x0, y0: statLabels.assist.y0 + gap, x1: statLabels.assist.x1, y1: statLabels.assist.y1 + gap }
      console.log(`Estimating death label at y=${est.y0}`)
      if (result.deaths === null) result.deaths = findStatNumber(est, 'deaths (estimated)')
    }

    // Targeted crop fallback for any stats still null.
    // On clean images (PS5 screenshots), a focused crop of just
    // the number region above the label reads reliably.
    async function cropFallback(
      label: { x0: number; y0: number; x1: number; y1: number },
      statName: string,
    ): Promise<number | null> {
      const labelHeight = label.y1 - label.y0

      // Crop: left-aligned with label, reaching above it
      const cropW = 200
      const cropH = Math.min(labelHeight * 3, 150)
      const cropX = Math.max(0, label.x0 - 40)
      const cropY = Math.max(0, label.y0 - cropH)

      // Use the original (unprocessed) image for cropping
      const cropCanvas = document.createElement('canvas')
      cropCanvas.width = img.naturalWidth
      cropCanvas.height = img.naturalHeight
      cropCanvas.getContext('2d')!.drawImage(img, 0, 0)

      const numCanvas = document.createElement('canvas')
      numCanvas.width = cropW
      numCanvas.height = cropH
      const numCtx = numCanvas.getContext('2d')!
      numCtx.drawImage(cropCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)

      // Scale up 4x with sharp edges
      const scaledCanvas = document.createElement('canvas')
      scaledCanvas.width = cropW * 4
      scaledCanvas.height = cropH * 4
      const scaledCtx = scaledCanvas.getContext('2d')!
      scaledCtx.imageSmoothingEnabled = false
      scaledCtx.drawImage(numCanvas, 0, 0, scaledCanvas.width, scaledCanvas.height)

      try {
        // Use digits-only mode for the crop
        await ocr.setParameters({ tessedit_char_whitelist: '0123456789' })
        const cropResult = await ocr.recognize(scaledCanvas)
        await ocr.setParameters({ tessedit_char_whitelist: '' })

        const text = cropResult.data.text.trim()
        console.log(`Crop fallback for "${statName}": "${text}" (crop ${cropX},${cropY} ${cropW}x${cropH})`)

        const numMatch = text.match(/(\d{1,3})/)
        if (numMatch) {
          const num = parseInt(numMatch[1])
          if (num >= 0 && num <= 150) {
            console.log(`  → Crop accepted: ${num}`)
            return num
          }
        }
      } catch (e) {
        console.warn(`Crop fallback failed for ${statName}:`, e)
        await ocr.setParameters({ tessedit_char_whitelist: '' })
      }
      return null
    }

    if (result.eliminations === null && statLabels.elim) {
      result.eliminations = await cropFallback(statLabels.elim, 'eliminations')
    }
    if (result.assists === null && statLabels.assist) {
      result.assists = await cropFallback(statLabels.assist, 'assists')
    }
    if (result.deaths === null && statLabels.death) {
      result.deaths = await cropFallback(statLabels.death, 'deaths')
    }

    // Line-based fallback (last resort)
    if (result.eliminations === null || result.assists === null || result.deaths === null) {
      const numberedLines = lines.map((line, i) => ({ text: line, upper: line.toUpperCase(), index: i }))
      function findStatInLines(lPatterns: string[]): number | null {
        for (const nl of numberedLines) {
          if (!lPatterns.some(p => nl.upper.includes(p))) continue
          for (let offset = 1; offset <= 3; offset++) {
            const prevIdx = nl.index - offset
            if (prevIdx < 0) break
            const prevLine = lines[prevIdx].trim()
            const numMatch = prevLine.match(/^(\d{1,2})$/)
            if (numMatch) return parseInt(numMatch[1])
          }
        }
        return null
      }
      if (result.eliminations === null) result.eliminations = findStatInLines(['ELIMINATION', 'ELIM', 'ELMINATION'])
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
  for (const map of MAPS) {
    const mapUpper = map.name.toUpperCase()
    if (upperText.includes(mapUpper)) return map.name
  }

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

    if (upper.length < 3 || upper.length > 20) continue
    if (/^\d+$/.test(upper)) continue
    if (upper.includes('PLAYED') || upper.includes('PERCENT')) continue
    if (upper.includes('TIME') || upper.includes('AVG')) continue

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
