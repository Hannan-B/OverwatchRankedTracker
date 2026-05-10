// ============================================================
// HERO MATCHER — Uses Web Worker for OpenCV operations
// ORB matching (50%) runs in worker
// Structural (30%) + Color Moments (20%) run in main thread
// NOW WITH ROLE FILTERING + SANITY CHECK + AUTO-CORRECT
// ============================================================

import { HEROES } from '@/data/reference'
import { orbMatchScore, detectPortraits as workerDetectPortraits } from './opencv-loader'
import type { RoleType } from '@/lib/types'

interface MatchResult {
  heroName: string
  score: number
  margin: number
  runnerUp: string
  correctedRole?: RoleType // set when matched hero's role differs from selected role
}

// Hero bank: name -> { img, pixelData }
interface HeroBankEntry {
  img: HTMLImageElement
  pixelData: { data: number[]; width: number; height: number }
}

const heroBank = new Map<string, HeroBankEntry>()
let bankLoaded = false

// Map display names to safe filenames
const HERO_FILENAME_MAP: Record<string, string> = {
  'Soldier: 76': 'Soldier_76',
  'Torbjörn': 'Torbjorn_safe',
  'Lúcio': 'Lucio_safe',
}

function heroFilename(name: string): string {
  return HERO_FILENAME_MAP[name] || name
}

// Build a quick lookup: hero name -> role
const HERO_ROLE_MAP = new Map<string, RoleType>()
for (const hero of HEROES) {
  HERO_ROLE_MAP.set(hero.name, hero.role)
}

// ============================================================
// LOAD HERO BANK
// ============================================================

export async function loadHeroBank(): Promise<void> {
  if (bankLoaded) return

  const loadPromises = HEROES.map(hero => {
    return new Promise<void>((resolve) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        // Also extract pixel data for worker communication
        const canvas = document.createElement('canvas')
        canvas.width = 128
        canvas.height = 128
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, 128, 128)
        const imageData = ctx.getImageData(0, 0, 128, 128)

        heroBank.set(hero.name, {
          img,
          pixelData: {
            data: Array.from(imageData.data),
            width: 128,
            height: 128,
          },
        })
        resolve()
      }
      img.onerror = () => {
        console.warn(`Failed to load hero image: ${hero.name}`)
        resolve()
      }
      img.src = `/heroes/${heroFilename(hero.name)}.png`
    })
  })

  await Promise.all(loadPromises)
  bankLoaded = true
  console.log(`Hero bank loaded: ${heroBank.size} heroes`)
}

// ============================================================
// PURE JS MATCHING (main thread)
// ============================================================

function getPixelData(canvas: HTMLCanvasElement): ImageData {
  return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  const s = max === 0 ? 0 : d / max
  const v = max

  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  return [h * 180, s * 255, v * 255]
}

function structuralMatch(testData: number[], bankData: number[], size: number): number {
  const n = size * size
  const testGray = new Float32Array(n)
  const bankGray = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    const idx = i * 4
    testGray[i] = 0.299 * testData[idx] + 0.587 * testData[idx + 1] + 0.114 * testData[idx + 2]
    bankGray[i] = 0.299 * bankData[idx] + 0.587 * bankData[idx + 1] + 0.114 * bankData[idx + 2]
  }

  let testMean = 0, bankMean = 0
  for (let i = 0; i < n; i++) { testMean += testGray[i]; bankMean += bankGray[i] }
  testMean /= n; bankMean /= n

  let num = 0, denomA = 0, denomB = 0
  for (let i = 0; i < n; i++) {
    const a = testGray[i] - testMean
    const b = bankGray[i] - bankMean
    num += a * b; denomA += a * a; denomB += b * b
  }

  const denom = Math.sqrt(denomA * denomB)
  return denom === 0 ? 0 : num / denom
}

function colorMoments(data: number[], size: number): Float64Array {
  const n = size * size
  const h = new Float64Array(n), s = new Float64Array(n), v = new Float64Array(n)

  for (let i = 0; i < n; i++) {
    const idx = i * 4
    const [hv, sv, vv] = rgbToHsv(data[idx], data[idx + 1], data[idx + 2])
    h[i] = hv; s[i] = sv; v[i] = vv
  }

  const moments = new Float64Array(9)
  const channels = [h, s, v]
  for (let c = 0; c < 3; c++) {
    const ch = channels[c]
    let mean = 0
    for (let i = 0; i < n; i++) mean += ch[i]
    mean /= n
    let variance = 0, skewSum = 0
    for (let i = 0; i < n; i++) {
      const diff = ch[i] - mean
      variance += diff * diff; skewSum += diff * diff * diff
    }
    moments[c * 3] = mean
    moments[c * 3 + 1] = Math.sqrt(variance / n)
    moments[c * 3 + 2] = Math.cbrt(skewSum / n)
  }
  return moments
}

function compareMoments(testData: number[], bankData: number[], size: number): number {
  const testM = colorMoments(testData, size)
  const bankM = colorMoments(bankData, size)
  let distSq = 0
  for (let i = 0; i < 9; i++) {
    const diff = testM[i] - bankM[i]
    distSq += diff * diff
  }
  return 1 / (1 + Math.sqrt(distSq))
}

// ============================================================
// RESIZE PIXEL DATA (for structural + color matching)
// ============================================================

function resizePixelData(data: number[], srcW: number, srcH: number, dstSize: number): number[] {
  const canvas = document.createElement('canvas')
  canvas.width = srcW; canvas.height = srcH
  const ctx = canvas.getContext('2d')!
  const imgData = ctx.createImageData(srcW, srcH)
  for (let i = 0; i < data.length; i++) imgData.data[i] = data[i]
  ctx.putImageData(imgData, 0, 0)

  const resized = document.createElement('canvas')
  resized.width = dstSize; resized.height = dstSize
  resized.getContext('2d')!.drawImage(canvas, 0, 0, dstSize, dstSize)

  return Array.from(resized.getContext('2d')!.getImageData(0, 0, dstSize, dstSize).data)
}

// ============================================================
// COMBINED MATCHING (worker ORB + main thread structural/color)
// ============================================================

async function combinedScore(
  portraitData: { data: number[]; width: number; height: number },
  bankEntry: HeroBankEntry,
  useOrb: boolean,
): Promise<number> {
  // Resize portrait to 64x64 for structural + color
  const testResized = resizePixelData(portraitData.data, portraitData.width, portraitData.height, 64)
  const bankResized = resizePixelData(bankEntry.pixelData.data, 128, 128, 64)

  const structural = structuralMatch(testResized, bankResized, 64)
  const moments = compareMoments(testResized, bankResized, 64)

  let orb = 0
  if (useOrb) {
    try {
      orb = await orbMatchScore(portraitData, bankEntry.pixelData)
    } catch (e) {
      console.warn('ORB match failed, using structural+color only')
    }
  }

  // When ORB is disabled, reweight structural and color
  // structural (60%) + color (40%) instead of the usual 50/30/20 split
  if (!useOrb) {
    return 0.6 * structural + 0.4 * moments
  }

  return 0.5 * orb + 0.3 * structural + 0.2 * moments
}

// ============================================================
// MATCH AGAINST A SUBSET OF HEROES
// ============================================================

async function matchAgainstCandidates(
  portraitData: { data: number[]; width: number; height: number },
  candidates: [string, HeroBankEntry][],
  useOrb: boolean,
): Promise<{ heroName: string; score: number; margin: number; runnerUp: string }> {
  const scores: [string, number][] = []

  for (const [name, entry] of candidates) {
    const score = await combinedScore(portraitData, entry, useOrb)
    scores.push([name, score])
  }

  scores.sort((a, b) => b[1] - a[1])

  return {
    heroName: scores[0][0],
    score: scores[0][1],
    margin: scores.length > 1 ? scores[0][1] - scores[1][1] : scores[0][1],
    runnerUp: scores.length > 1 ? scores[1][0] : 'N/A',
  }
}

// ============================================================
// PUBLIC API
// ============================================================

export async function matchHero(
  portraitData: { data: number[]; width: number; height: number },
  useOrb: boolean,
  roleFilter?: RoleType,
): Promise<MatchResult> {
  const allEntries = Array.from(heroBank.entries())

  // If no role filter, match against all heroes (original behaviour)
  if (!roleFilter) {
    const result = await matchAgainstCandidates(portraitData, allEntries, useOrb)
    return result
  }

  // Step 1: Match against role-filtered candidates (full ORB + structural + color)
  const filteredEntries = allEntries.filter(
    ([name]) => HERO_ROLE_MAP.get(name) === roleFilter
  )

  console.log(`Role filter: ${roleFilter} → ${filteredEntries.length} candidates (of ${allEntries.length} total)`)

  const filteredResult = await matchAgainstCandidates(portraitData, filteredEntries, useOrb)

  console.log(`Filtered match: ${filteredResult.heroName} (score: ${filteredResult.score.toFixed(4)}, margin: ${filteredResult.margin.toFixed(4)})`)

  // Step 2: Sanity check — run FAST structural+color-only (no ORB) against ALL heroes
  // This is cheap because ORB is the slow part (~95% of matching time)
  console.log(`Running sanity check (structural+color only) against all ${allEntries.length} heroes...`)
  const sanityResult = await matchAgainstCandidates(portraitData, allEntries, false)
  const sanityRole = HERO_ROLE_MAP.get(sanityResult.heroName)

  console.log(`Sanity check winner: ${sanityResult.heroName} (${sanityRole}) score: ${sanityResult.score.toFixed(4)}`)

  // Step 3: If sanity check agrees with the filtered role, trust the filtered result
  if (sanityRole === roleFilter) {
    console.log(`Sanity check confirms role "${roleFilter}" — using filtered result`)
    return filteredResult
  }

  // Step 4: Sanity check disagrees — the user likely picked the wrong role
  // Run full ORB match on all heroes to get the definitive answer
  console.log(`Sanity check disagrees: filtered="${roleFilter}" vs sanity="${sanityRole}" (${sanityResult.heroName})`)
  console.log(`Running full match (with ORB) against all ${allEntries.length} heroes...`)

  const fullResult = await matchAgainstCandidates(portraitData, allEntries, useOrb)
  const fullRole = HERO_ROLE_MAP.get(fullResult.heroName)

  console.log(`Full match winner: ${fullResult.heroName} (${fullRole}) score: ${fullResult.score.toFixed(4)}`)

  // If the full match found a hero in the filtered role after all,
  // the sanity check was a false alarm — use the filtered result
  if (fullRole === roleFilter) {
    console.log(`Full match agrees with filtered role "${roleFilter}" — sanity check was a false alarm`)
    return filteredResult
  }

  // Full match confirms wrong role — auto-correct
  console.log(`AUTO-CORRECT: Selected role was "${roleFilter}" but matched hero "${fullResult.heroName}" is "${fullRole}"`)
  return {
    ...fullResult,
    correctedRole: fullRole,
  }
}

export async function detectAndMatchHeroes(
  img: HTMLImageElement,
  pageType: 'summary' | 'breakdown',
  opencvAvailable: boolean,
  roleFilter?: RoleType,
): Promise<MatchResult[]> {
  await loadHeroBank()

  if (!opencvAvailable) return []

  // Get image pixel data
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  canvas.getContext('2d')!.drawImage(img, 0, 0)
  const imgData = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)

  // Detect portraits via worker
  const portraits = await workerDetectPortraits(
    imgData.data,
    canvas.width,
    canvas.height,
    pageType,
  )

  console.log(`Detected ${portraits.length} portrait(s) on ${pageType} page`)

  // Match each portrait (with role filter + sanity check)
  const results: MatchResult[] = []
  for (const portrait of portraits) {
    const result = await matchHero(portrait, true, roleFilter)
    console.log(`Matched: ${result.heroName} (score: ${result.score.toFixed(4)}, margin: ${result.margin.toFixed(4)}${result.correctedRole ? `, ROLE CORRECTED → ${result.correctedRole}` : ''})`)
    results.push(result)
  }

  return results
}

export { loadHeroBank as preloadHeroBank }
