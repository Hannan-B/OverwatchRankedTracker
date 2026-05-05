// ============================================================
// IMAGE PROCESSOR — Orchestrates the full processing pipeline
// Loads photos, detects page type, runs hero matching + OCR,
// returns structured match data ready to save
// ============================================================

import { loadOpenCV } from './opencv-loader'
import { preloadHeroBank, identifyHeroes } from './hero-matcher'
import { ocrSummaryPage, terminateOcr, type SummaryOcrResult } from './ocr-extractor'

export interface ProcessedMatch {
  // From OCR
  mapName: string | null
  result: 'victory' | 'defeat' | 'draw' | null
  score: string | null
  gameLengthSeconds: number | null
  eliminations: number | null
  assists: number | null
  deaths: number | null

  // From hero matching
  heroes: {
    name: string
    confidence: number
    source: 'image' | 'ocr' | 'both'
  }[]

  // Debug info
  ocrRaw: Record<string, string>
  processingTimeMs: number
}

export type ProcessingStatus =
  | { stage: 'loading_opencv'; progress: 0 }
  | { stage: 'loading_heroes'; progress: 10 }
  | { stage: 'processing_photo'; progress: number; photoIndex: number; total: number }
  | { stage: 'running_ocr'; progress: number }
  | { stage: 'matching_heroes'; progress: number }
  | { stage: 'complete'; progress: 100 }

export async function processMatchPhotos(
  photoUrls: string[],
  onStatus: (status: ProcessingStatus) => void,
): Promise<ProcessedMatch> {
  const startTime = Date.now()

  const result: ProcessedMatch = {
    mapName: null, result: null, score: null,
    gameLengthSeconds: null, eliminations: null,
    assists: null, deaths: null, heroes: [],
    ocrRaw: {}, processingTimeMs: 0,
  }

  // Step 1: Load OpenCV
  onStatus({ stage: 'loading_opencv', progress: 0 })
  let cv: any
  try {
    cv = await loadOpenCV()
  } catch (e) {
    console.error('Failed to load OpenCV:', e)
    // Continue without OpenCV — OCR still works
    cv = null
  }

  // Step 2: Load hero bank
  onStatus({ stage: 'loading_heroes', progress: 10 })
  await preloadHeroBank()

  // Step 3: Load all photos as Image elements
  const images: HTMLImageElement[] = []
  for (let i = 0; i < photoUrls.length; i++) {
    onStatus({
      stage: 'processing_photo',
      progress: 15 + (i / photoUrls.length) * 20,
      photoIndex: i,
      total: photoUrls.length,
    })

    try {
      const img = await loadImage(photoUrls[i])
      images.push(img)
    } catch (e) {
      console.warn(`Failed to load photo ${i}:`, e)
    }
  }

  if (images.length === 0) {
    result.processingTimeMs = Date.now() - startTime
    onStatus({ stage: 'complete', progress: 100 })
    return result
  }

  // Step 4: Determine page types and run OCR on Summary page
  // The first photo is most likely the Summary page
  onStatus({ stage: 'running_ocr', progress: 40 })

  let summaryOcr: SummaryOcrResult | null = null
  try {
    // Try OCR on the first image (assumed Summary page)
    summaryOcr = await ocrSummaryPage(images[0])
    result.mapName = summaryOcr.mapName
    result.result = summaryOcr.result
    result.score = summaryOcr.score
    result.gameLengthSeconds = summaryOcr.gameLengthSeconds
    result.eliminations = summaryOcr.eliminations
    result.assists = summaryOcr.assists
    result.deaths = summaryOcr.deaths
    result.ocrRaw = summaryOcr.raw
  } catch (e) {
    console.warn('Summary OCR failed:', e)
  }

  // Step 5: Run hero matching on all images
  onStatus({ stage: 'matching_heroes', progress: 60 })

  const allHeroMatches: Map<string, { score: number; source: 'image' | 'ocr' | 'both' }> = new Map()

  if (cv) {
    // Try Summary page hero detection on first image
    try {
      const summaryHeroes = await identifyHeroes(cv, images[0], 'summary')
      for (const match of summaryHeroes) {
        allHeroMatches.set(match.heroName, { score: match.score, source: 'image' })
      }
    } catch (e) {
      console.warn('Summary hero detection failed:', e)
    }

    // Try Breakdown page hero detection on remaining images
    for (let i = 1; i < images.length; i++) {
      onStatus({
        stage: 'matching_heroes',
        progress: 60 + ((i / images.length) * 30),
      })

      try {
        const breakdownHeroes = await identifyHeroes(cv, images[i], 'breakdown')
        for (const match of breakdownHeroes) {
          const existing = allHeroMatches.get(match.heroName)
          if (existing) {
            existing.source = 'both'
            existing.score = Math.max(existing.score, match.score)
          } else {
            allHeroMatches.set(match.heroName, { score: match.score, source: 'image' })
          }
        }
      } catch (e) {
        console.warn(`Breakdown hero detection failed for image ${i}:`, e)
      }
    }
  } else {
    console.warn('OpenCV not available — using OCR-only hero detection')
  }

  // Add OCR hero names (cross-reference if image matching found them too)
  if (summaryOcr?.heroNames) {
    for (const ocrHero of summaryOcr.heroNames) {
      const existing = allHeroMatches.get(ocrHero)
      if (existing) {
        existing.source = 'both'
      } else {
        allHeroMatches.set(ocrHero, { score: 0.5, source: 'ocr' })
      }
    }
  }

  // Convert to sorted array
  result.heroes = Array.from(allHeroMatches.entries())
    .map(([name, data]) => ({
      name,
      confidence: data.score,
      source: data.source,
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)

  // Clean up
  await terminateOcr()

  result.processingTimeMs = Date.now() - startTime
  onStatus({ stage: 'complete', progress: 100 })

  return result
}

// ============================================================
// UTILITIES
// ============================================================

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load: ${url}`))
    img.src = url
  })
}
