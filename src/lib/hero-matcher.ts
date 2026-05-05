// ============================================================
// HERO MATCHER — Browser port of validated Python pipeline
// ORB (50%) + Structural Similarity (30%) + Color Moments (20%)
// Validated: 78/78 correct (100%) in Python testing
// ============================================================

import { HEROES } from '@/data/reference'

interface MatchResult {
  heroName: string
  score: number
  margin: number
  runnerUp: string
}

let heroBank: Map<string, HTMLImageElement> = new Map()
let bankLoaded = false

// ============================================================
// LOAD HERO BANK
// ============================================================

// Map hero display names to safe filenames
const HERO_FILENAME_MAP: Record<string, string> = {
  'Soldier: 76': 'Soldier_76',
  'Torbjörn': 'Torbjorn_safe',
  'Lúcio': 'Lucio_safe',
  'D.Va': 'D.Va',
}

function heroFilename(name: string): string {
  return HERO_FILENAME_MAP[name] || name
}

export async function loadHeroBank(): Promise<void> {
  if (bankLoaded) return

  const loadPromises = HEROES.map(hero => {
    return new Promise<void>((resolve) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        heroBank.set(hero.name, img)
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
// IMAGE UTILITIES
// ============================================================

function imageToCanvas(img: HTMLImageElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, width, height)
  return canvas
}

function getPixelData(canvas: HTMLCanvasElement): ImageData {
  const ctx = canvas.getContext('2d')!
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

function canvasFromMat(cv: any, mat: any): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  cv.imshow(canvas, mat)
  return canvas
}

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = URL.createObjectURL(blob)
  })
}

// ============================================================
// RGB TO HSV CONVERSION (pure JS for color moments)
// ============================================================

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const d = max - min
  let h = 0, s = max === 0 ? 0 : d / max, v = max

  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }

  return [h * 180, s * 255, v * 255] // Match OpenCV HSV ranges
}

// ============================================================
// MATCHING FUNCTIONS
// ============================================================

function structuralMatch(testCanvas: HTMLCanvasElement, bankCanvas: HTMLCanvasElement): number {
  const size = 64
  const testResized = document.createElement('canvas')
  testResized.width = size; testResized.height = size
  testResized.getContext('2d')!.drawImage(testCanvas, 0, 0, size, size)

  const bankResized = document.createElement('canvas')
  bankResized.width = size; bankResized.height = size
  bankResized.getContext('2d')!.drawImage(bankCanvas, 0, 0, size, size)

  const testData = getPixelData(testResized).data
  const bankData = getPixelData(bankResized).data

  // Convert to grayscale and compute normalized cross-correlation
  const n = size * size
  const testGray = new Float32Array(n)
  const bankGray = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    const idx = i * 4
    testGray[i] = 0.299 * testData[idx] + 0.587 * testData[idx + 1] + 0.114 * testData[idx + 2]
    bankGray[i] = 0.299 * bankData[idx] + 0.587 * bankData[idx + 1] + 0.114 * bankData[idx + 2]
  }

  // NCC
  let testMean = 0, bankMean = 0
  for (let i = 0; i < n; i++) { testMean += testGray[i]; bankMean += bankGray[i] }
  testMean /= n; bankMean /= n

  let num = 0, denomA = 0, denomB = 0
  for (let i = 0; i < n; i++) {
    const a = testGray[i] - testMean
    const b = bankGray[i] - bankMean
    num += a * b
    denomA += a * a
    denomB += b * b
  }

  const denom = Math.sqrt(denomA * denomB)
  return denom === 0 ? 0 : num / denom
}

function colorMoments(canvas: HTMLCanvasElement): Float64Array {
  const size = 64
  const resized = document.createElement('canvas')
  resized.width = size; resized.height = size
  resized.getContext('2d')!.drawImage(canvas, 0, 0, size, size)
  const data = getPixelData(resized).data
  const n = size * size

  // Extract HSV channels
  const h = new Float64Array(n)
  const s = new Float64Array(n)
  const v = new Float64Array(n)

  for (let i = 0; i < n; i++) {
    const idx = i * 4
    const [hv, sv, vv] = rgbToHsv(data[idx], data[idx + 1], data[idx + 2])
    h[i] = hv; s[i] = sv; v[i] = vv
  }

  // Compute moments (mean, std, skewness) for each channel
  const moments = new Float64Array(9)
  const channels = [h, s, v]

  for (let c = 0; c < 3; c++) {
    const ch = channels[c]
    let mean = 0
    for (let i = 0; i < n; i++) mean += ch[i]
    mean /= n

    let variance = 0
    let skewSum = 0
    for (let i = 0; i < n; i++) {
      const diff = ch[i] - mean
      variance += diff * diff
      skewSum += diff * diff * diff
    }
    variance /= n
    const std = Math.sqrt(variance)
    const skew = Math.cbrt(skewSum / n)

    moments[c * 3] = mean
    moments[c * 3 + 1] = std
    moments[c * 3 + 2] = skew
  }

  return moments
}

function compareMoments(testCanvas: HTMLCanvasElement, bankCanvas: HTMLCanvasElement): number {
  const testM = colorMoments(testCanvas)
  const bankM = colorMoments(bankCanvas)
  let distSq = 0
  for (let i = 0; i < 9; i++) {
    const diff = testM[i] - bankM[i]
    distSq += diff * diff
  }
  return 1 / (1 + Math.sqrt(distSq))
}

function orbMatch(cv: any, testCanvas: HTMLCanvasElement, bankCanvas: HTMLCanvasElement): number {
  const size = 128

  // Create cv.Mat from canvases
  const testResized = document.createElement('canvas')
  testResized.width = size; testResized.height = size
  testResized.getContext('2d')!.drawImage(testCanvas, 0, 0, size, size)

  const bankResized = document.createElement('canvas')
  bankResized.width = size; bankResized.height = size
  bankResized.getContext('2d')!.drawImage(bankCanvas, 0, 0, size, size)

  let testMat, bankMat, testGray, bankGray
  let kp1, kp2, des1, des2, bf, matches

  try {
    testMat = cv.imread(testResized)
    bankMat = cv.imread(bankResized)
    testGray = new cv.Mat()
    bankGray = new cv.Mat()

    cv.cvtColor(testMat, testGray, cv.COLOR_RGBA2GRAY)
    cv.cvtColor(bankMat, bankGray, cv.COLOR_RGBA2GRAY)

    const orb = new cv.ORB(200)
    kp1 = new cv.KeyPointVector()
    kp2 = new cv.KeyPointVector()
    des1 = new cv.Mat()
    des2 = new cv.Mat()

    orb.detectAndCompute(testGray, new cv.Mat(), kp1, des1)
    orb.detectAndCompute(bankGray, new cv.Mat(), kp2, des2)

    if (des1.rows < 2 || des2.rows < 2) {
      return 0
    }

    bf = new cv.BFMatcher(cv.NORM_HAMMING, false)
    matches = new cv.DMatchVectorVector()
    bf.knnMatch(des1, des2, matches, 2)

    // Lowe's ratio test
    let goodCount = 0
    for (let i = 0; i < matches.size(); i++) {
      const match = matches.get(i)
      if (match.size() >= 2) {
        const m = match.get(0)
        const n = match.get(1)
        if (m.distance < 0.75 * n.distance) {
          goodCount++
        }
      }
    }

    return goodCount / Math.max(kp1.size(), 1)

  } catch (e) {
    console.warn('ORB match error:', e)
    return 0
  } finally {
    // Clean up OpenCV Mats
    testMat?.delete()
    bankMat?.delete()
    testGray?.delete()
    bankGray?.delete()
    kp1?.delete()
    kp2?.delete()
    des1?.delete()
    des2?.delete()
    matches?.delete()
  }
}

// ============================================================
// COMBINED MATCHING
// ============================================================

function combinedScore(cv: any, testCanvas: HTMLCanvasElement, bankCanvas: HTMLCanvasElement): number {
  const orb = orbMatch(cv, testCanvas, bankCanvas)
  const structural = structuralMatch(testCanvas, bankCanvas)
  const moments = compareMoments(testCanvas, bankCanvas)
  return 0.5 * orb + 0.3 * structural + 0.2 * moments
}

export function matchHero(cv: any, portraitCanvas: HTMLCanvasElement): MatchResult {
  const scores: [string, number][] = []

  for (const [name, img] of heroBank.entries()) {
    const bankCanvas = imageToCanvas(img, 128, 128)
    const score = combinedScore(cv, portraitCanvas, bankCanvas)
    scores.push([name, score])
  }

  scores.sort((a, b) => b[1] - a[1])

  return {
    heroName: scores[0][0],
    score: scores[0][1],
    margin: scores[0][1] - scores[1][1],
    runnerUp: scores[1][0],
  }
}

// ============================================================
// PORTRAIT DETECTION (from full screenshot)
// ============================================================

export function detectPortraits(cv: any, img: HTMLImageElement, pageType: 'summary' | 'breakdown'): HTMLCanvasElement[] {
  const fullCanvas = imageToCanvas(img, img.naturalWidth, img.naturalHeight)
  const w = fullCanvas.width
  const h = fullCanvas.height

  let regionX1: number, regionX2: number, regionY1: number, regionY2: number

  if (pageType === 'summary') {
    // Summary page: portraits in left 28%, y range 20-78%
    regionX1 = 0; regionX2 = Math.floor(w * 0.28)
    regionY1 = Math.floor(h * 0.20); regionY2 = Math.floor(h * 0.78)
  } else {
    // Breakdown page: portrait in stat grid, 20-40% x, 20-50% y
    regionX1 = Math.floor(w * 0.20); regionX2 = Math.floor(w * 0.40)
    regionY1 = Math.floor(h * 0.20); regionY2 = Math.floor(h * 0.50)
  }

  const regionW = regionX2 - regionX1
  const regionH = regionY2 - regionY1

  // Crop the region
  const regionCanvas = document.createElement('canvas')
  regionCanvas.width = regionW
  regionCanvas.height = regionH
  regionCanvas.getContext('2d')!.drawImage(
    fullCanvas, regionX1, regionY1, regionW, regionH, 0, 0, regionW, regionH
  )

  // Use OpenCV HoughCircles to find portraits
  let src, gray, blurred
  const portraits: HTMLCanvasElement[] = []

  try {
    src = cv.imread(regionCanvas)
    gray = new cv.Mat()
    blurred = new cv.Mat()

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.GaussianBlur(gray, blurred, new cv.Size(9, 9), 3)

    // Multi-parameter sweep (matching Python approach)
    const allCircles: [number, number, number][] = []
    const dpValues = [1.2, 1.5, 2.0]
    const p2Values = [30, 40, 50, 60]

    for (const dp of dpValues) {
      for (const p2 of p2Values) {
        const circles = new cv.Mat()
        try {
          cv.HoughCircles(
            blurred, circles, cv.HOUGH_GRADIENT,
            dp, 350, 100, p2, 110, 210
          )

          for (let i = 0; i < circles.cols; i++) {
            const x = circles.data32F[i * 3]
            const y = circles.data32F[i * 3 + 1]
            const r = circles.data32F[i * 3 + 2]

            if (y > regionH * 0.15 && y < regionH * 0.85) {
              allCircles.push([Math.round(x), Math.round(y), Math.round(r)])
            }
          }
        } catch (e) {
          // Some parameter combos may fail
        } finally {
          circles.delete()
        }
      }
    }

    if (allCircles.length === 0) return portraits

    // Cluster by y position
    allCircles.sort((a, b) => a[1] - b[1])
    const groups: [number, number, number][][] = [[allCircles[0]]]

    for (let i = 1; i < allCircles.length; i++) {
      const lastGroup = groups[groups.length - 1]
      if (Math.abs(allCircles[i][1] - lastGroup[0][1]) < 250) {
        lastGroup.push(allCircles[i])
      } else {
        groups.push([allCircles[i]])
      }
    }

    // Take median of each group, filter by brightness
    for (const group of groups) {
      if (group.length < 10) continue // Low confidence

      const xs = group.map(c => c[0]).sort((a, b) => a - b)
      const ys = group.map(c => c[1]).sort((a, b) => a - b)
      const rs = group.map(c => c[2]).sort((a, b) => a - b)

      const x = xs[Math.floor(xs.length / 2)]
      const y = ys[Math.floor(ys.length / 2)]
      const r = rs[Math.floor(rs.length / 2)]

      // Check brightness of interior
      const innerR = Math.floor(r * 0.55)
      const iy1 = Math.max(0, y - innerR)
      const iy2 = Math.min(regionH, y + innerR)
      const ix1 = Math.max(0, x - innerR)
      const ix2 = Math.min(regionW, x + innerR)

      const roiCanvas = document.createElement('canvas')
      const roiW = ix2 - ix1, roiH = iy2 - iy1
      roiCanvas.width = roiW; roiCanvas.height = roiH
      roiCanvas.getContext('2d')!.drawImage(
        regionCanvas, ix1, iy1, roiW, roiH, 0, 0, roiW, roiH
      )

      const roiData = getPixelData(roiCanvas).data
      let totalBrightness = 0
      const pixelCount = roiW * roiH
      for (let i = 0; i < pixelCount; i++) {
        const idx = i * 4
        totalBrightness += (roiData[idx] + roiData[idx + 1] + roiData[idx + 2]) / 3
      }
      const avgBrightness = totalBrightness / pixelCount

      if (avgBrightness < 50) continue // Dark/empty slot

      // Crop the portrait (exclude ring border)
      const cropR = Math.floor(r * (pageType === 'breakdown' ? 0.80 : 0.65))
      const cropMinR = pageType === 'breakdown' ? 140 : 0
      const finalR = Math.max(cropR, cropMinR)

      const cy1 = Math.max(0, y - finalR)
      const cy2 = Math.min(regionH, y + finalR)
      const cx1 = Math.max(0, x - finalR)
      const cx2 = Math.min(regionW, x + finalR)

      const portraitCanvas = document.createElement('canvas')
      const pw = cx2 - cx1, ph = cy2 - cy1
      portraitCanvas.width = pw; portraitCanvas.height = ph
      portraitCanvas.getContext('2d')!.drawImage(
        regionCanvas, cx1, cy1, pw, ph, 0, 0, pw, ph
      )

      portraits.push(portraitCanvas)
    }

  } finally {
    src?.delete()
    gray?.delete()
    blurred?.delete()
  }

  return portraits
}

// ============================================================
// CONVENIENCE: detect + match in one call
// ============================================================

export async function identifyHeroes(
  cv: any,
  img: HTMLImageElement,
  pageType: 'summary' | 'breakdown'
): Promise<MatchResult[]> {
  await loadHeroBank()
  const portraits = detectPortraits(cv, img, pageType)
  return portraits.map(p => matchHero(cv, p))
}

export { loadHeroBank as preloadHeroBank }
