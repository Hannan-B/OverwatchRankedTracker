// ============================================================
// IMAGE PROCESSOR — Orchestrates the full processing pipeline
// OpenCV runs in a Web Worker (isolated from Next.js)
// OCR runs in the main thread via Tesseract.js
// NOW WITH ROLE FILTERING + AUTO-CORRECT
// ============================================================

import { initOpenCV, isOpenCVReady } from './opencv-loader'
import { preloadHeroBank, detectAndMatchHeroes } from './hero-matcher'
import { ocrSummaryPage, terminateOcr, type SummaryOcrResult } from './ocr-extractor'
import type { RoleType } from '@/lib/types'

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
  correctedRole: RoleType | null  // set when hero matching detected wrong role selection
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

// ============================================================
// RESULT FROM SCORE
// ============================================================
// Derives victory/defeat/draw from the score string.
// Score format is "X-Y" where X is the player's team score
// and Y is the opponent's score.

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
    correctedRole: null,
    ocrRaw: {}, processingTimeMs: 0,
  }

  // Step 1: Initialize OpenCV Web Worker
  onStatus({ stage: 'loading_opencv', progress: 0 })
  let opencvAvailable = false
  try {
    opencvAvailable = await initOpenCV()
    console.log('OpenCV available:', opencvAvailable)
  } catch (e) {
    console.warn('OpenCV Worker failed:', e)
  }

  // Step 2: Load hero bank
  onStatus({ stage: 'loading_heroes', progress: 10 })
  await preloadHeroBank()

  if (roleFilter) {
    console.log(`Role filter active: ${roleFilter}`)
  }

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

  // Step 4: Run OCR on all images (full-image approach)
  onStatus({ stage: 'running_ocr', progress: 40 })

  let summaryOcr: SummaryOcrResult | null = null
  try {
    summaryOcr = await ocrSummaryPage(images[0])
    result.mapName = summaryOcr.mapName
    result.score = summaryOcr.score
    result.gameLengthSeconds = summaryOcr.gameLengthSeconds
    result.eliminations = summaryOcr.eliminations
    result.assists = summaryOcr.assists
    result.deaths = summaryOcr.deaths
    result.ocrRaw = summaryOcr.raw

    // Derive result from score (primary method)
    // Falls back to OCR-based detection if score isn't available
    const scoreResult = resultFromScore(result.score)
    if (scoreResult) {
      result.result = scoreResult
      console.log(`Result derived from score "${result.score}": ${scoreResult}`)
    } else {
      result.result = summaryOcr.result
      console.log(`Result from OCR fallback: ${result.result}`)
    }

    console.log('OCR results:', {
      map: result.mapName, result: result.result,
      score: result.score, elims: result.eliminations,
    })
  } catch (e) {
    console.warn('Summary OCR failed:', e)
  }

  // Step 5: Run hero matching via Web Worker (with role filter)
  onStatus({ stage: 'matching_heroes', progress: 60 })

  const allHeroMatches = new Map<string, { score: number; source: 'image' | 'ocr' | 'both' }>()
  let detectedCorrectedRole: RoleType | null = null

  if (opencvAvailable) {
    // Summary page hero detection (with role filter)
    try {
      const summaryHeroes = await detectAndMatchHeroes(images[0], 'summary', true, roleFilter)
      for (const match of summaryHeroes) {
        allHeroMatches.set(match.heroName, { score: match.score, source: 'image' })
        // If any hero triggered auto-correct, capture the corrected role
        if (match.correctedRole && !detectedCorrectedRole) {
          detectedCorrectedRole = match.correctedRole
          console.log(`Role auto-correct triggered: ${roleFilter} → ${match.correctedRole} (from hero ${match.heroName})`)
        }
      }
    } catch (e) {
      console.warn('Summary hero detection failed:', e)
    }

    // Breakdown page hero detection (with role filter)
    for (let i = 1; i < images.length; i++) {
      onStatus({ stage: 'matching_heroes', progress: 60 + ((i / images.length) * 30) })
      try {
        const breakdownHeroes = await detectAndMatchHeroes(images[i], 'breakdown', true, roleFilter)
        for (const match of breakdownHeroes) {
          const existing = allHeroMatches.get(match.heroName)
          if (existing) {
            existing.source = 'both'
            existing.score = Math.max(existing.score, match.score)
          } else {
            allHeroMatches.set(match.heroName, { score: match.score, source: 'image' })
          }
          // Capture auto-correct from breakdown pages too
          if (match.correctedRole && !detectedCorrectedRole) {
            detectedCorrectedRole = match.correctedRole
            console.log(`Role auto-correct triggered: ${roleFilter} → ${match.correctedRole} (from hero ${match.heroName})`)
          }
        }
      } catch (e) {
        console.warn(`Breakdown hero detection failed for image ${i}:`, e)
      }
    }
  } else {
    console.warn('OpenCV not available — using OCR-only hero detection')
  }

  // Add OCR hero names
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

  // Convert to sorted array, filter by confidence threshold
  // Threshold 0.13: keeps all validated correct matches (lowest was 0.14)
  // while filtering false positives (highest was 0.10)
  const HERO_CONFIDENCE_THRESHOLD = 0.13

  result.heroes = Array.from(allHeroMatches.entries())
    .map(([name, data]) => ({ name, confidence: data.score, source: data.source }))
    .filter(h => h.confidence >= HERO_CONFIDENCE_THRESHOLD || h.source === 'ocr')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)

  // Set corrected role if auto-correct was triggered
  result.correctedRole = detectedCorrectedRole

  // Clean up
  await terminateOcr()

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
