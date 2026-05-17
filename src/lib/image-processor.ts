// ============================================================
// IMAGE PROCESSOR — Orchestrates the full processing pipeline
// Auto-detects summary vs breakdown pages
// Portrait matcher identifies heroes on summary page
// Assignment by elimination for breakdown pages
// Catalog-driven stat extraction for breakdowns
// ============================================================

import { initOpenCV, isOpenCVReady } from './opencv-loader'
import { preloadHeroBank, detectAndMatchHeroes, matchHero } from './hero-matcher'
import { ocrSummaryPage, terminateOcr, type SummaryOcrResult } from './ocr-extractor'
import { ocrBreakdownPage, terminateBreakdownOcr, type BreakdownOcrResult, type BreakdownStat } from './breakdown-ocr'
import type { RoleType } from '@/lib/types'
import Tesseract from 'tesseract.js'

// ============================================================
// PAGE TYPE DETECTION
// ============================================================

type PageType = 'summary' | 'breakdown' | 'unknown'

let classifyWorker: Tesseract.Worker | null = null

async function getClassifyWorker(): Promise<Tesseract.Worker> {
  if (!classifyWorker) {
    classifyWorker = await Tesseract.createWorker('eng')
  }
  return classifyWorker
}

const SUMMARY_KEYWORDS = ['TOTAL PERFORMANCE', 'FINAL SCORE', 'GAME LENGTH']
const BREAKDOWN_KEYWORDS = ['PERCENT PLAYED', 'PLAY TIME']

async function classifyImage(img: HTMLImageElement): Promise<PageType> {
  const worker = await getClassifyWorker()

  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  canvas.getContext('2d')!.drawImage(img, 0, 0)

  const { data } = await worker.recognize(canvas)
  const text = data.text.toUpperCase()

  let summaryScore = 0
  let breakdownScore = 0

  for (const kw of SUMMARY_KEYWORDS) {
    if (text.includes(kw)) summaryScore++
  }
  for (const kw of BREAKDOWN_KEYWORDS) {
    if (text.includes(kw)) breakdownScore++
  }

  console.log(`Page classification: summary=${summaryScore}, breakdown=${breakdownScore}`)

  if (summaryScore >= 2 && summaryScore > breakdownScore) return 'summary'
  if (breakdownScore >= 1 && breakdownScore >= summaryScore) return 'breakdown'
  if (summaryScore >= 1) return 'summary'
  if (breakdownScore >= 1) return 'breakdown'

  return 'unknown'
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
}

export interface ProcessedMatch {
  mapName: string | null
  result: 'victory' | 'defeat' | 'draw' | null
  score: string | null
  gameLengthSeconds: number | null
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

  // Score each image's portrait against each known hero individually
  // This builds the full matrix needed for optimal greedy assignment
  const fullScoreMatrix: { imageIndex: number; heroName: string; score: number }[] = []

  for (let i = 0; i < breakdownImages.length; i++) {
    // Detect portrait from this image
    const canvas = document.createElement('canvas')
    canvas.width = breakdownImages[i].naturalWidth
    canvas.height = breakdownImages[i].naturalHeight
    canvas.getContext('2d')!.drawImage(breakdownImages[i], 0, 0)
    const imgData = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)

    // Import portrait detection
    const { detectPortraits } = await import('./opencv-loader')
    const portraits = await detectPortraits(
      imgData.data, canvas.width, canvas.height, 'breakdown',
    )

    if (portraits.length === 0) {
      console.warn(`Breakdown ${i + 1}: no portrait detected`)
      continue
    }

    // Score this portrait against each known hero
    for (const heroName of knownHeroNames) {
      const result = await matchHero(portraits[0], true, undefined, [heroName])
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

  // Greedy assignment: pick highest-confidence pair, assign, remove both, repeat
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
): Promise<ProcessedMatch> {
  const startTime = Date.now()

  const result: ProcessedMatch = {
    mapName: null, result: null, score: null,
    gameLengthSeconds: null, eliminations: null,
    assists: null, deaths: null, heroes: [],
    heroBreakdowns: [],
    correctedRole: null,
    ocrRaw: {}, processingTimeMs: 0,
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

  // Step 4: Auto-detect page types
  onStatus({ stage: 'classifying_pages', progress: 28 })
  let summaryImage: HTMLImageElement | null = null
  const breakdownImages: HTMLImageElement[] = []

  for (let i = 0; i < images.length; i++) {
    onStatus({ stage: 'classifying_pages', progress: 28 + ((i / images.length) * 10) })
    const pageType = await classifyImage(images[i])
    console.log(`Image ${i + 1}: classified as "${pageType}"`)

    if (pageType === 'summary' && !summaryImage) {
      summaryImage = images[i]
    } else if (pageType === 'breakdown') {
      breakdownImages.push(images[i])
    } else if (pageType === 'summary' && summaryImage) {
      breakdownImages.push(images[i])
    } else {
      breakdownImages.push(images[i])
    }
  }

  if (!summaryImage) {
    summaryImage = images[0]
    const idx = breakdownImages.indexOf(images[0])
    if (idx >= 0) breakdownImages.splice(idx, 1)
  }

  await terminateClassifyWorker()
  console.log(`Classification: 1 summary, ${breakdownImages.length} breakdown(s)`)

  // Step 5: Summary page OCR
  onStatus({ stage: 'running_ocr', progress: 40 })
  let summaryOcr: SummaryOcrResult | null = null
  try {
    summaryOcr = await ocrSummaryPage(summaryImage)
    result.mapName = summaryOcr.mapName
    result.score = summaryOcr.score
    result.gameLengthSeconds = summaryOcr.gameLengthSeconds
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
      const summaryHeroes = await detectAndMatchHeroes(summaryImage, 'summary', true, roleFilter)
      for (const match of summaryHeroes) {
        allHeroMatches.set(match.heroName, { score: match.score, source: 'image' })
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
    .slice(0, 3)

  result.correctedRole = detectedCorrectedRole
  const summaryHeroNames = new Set(result.heroes.map(h => h.name))
  console.log(`Summary heroes: [${Array.from(summaryHeroNames).join(', ')}]`)

  // Step 7: Assignment by elimination + catalog-driven OCR
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

  // Cleanup
  await terminateOcr()
  await terminateBreakdownOcr()

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
