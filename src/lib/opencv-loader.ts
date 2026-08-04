// ============================================================
// OPENCV WORKER CLIENT
// Manages the Web Worker that runs OpenCV.js in isolation
// All OpenCV operations go through this client
// ------------------------------------------------------------
// Health tracking added after the 2 Aug investigation: the worker
// previously leaked a cv.ORB and a cv.BFMatcher on every orbMatch()
// call and exhausted the Emscripten heap partway through a batch run.
// Every subsequent ORB call threw, hero-matcher silently substituted
// orb = 0, and 40% of the run scored on a different formula while
// reporting the same "confidence" column.
//
// The leak itself is fixed in /public/opencv-worker.js. What lives
// here is the safety net: count failures, restart the worker if ORB
// starts failing, and expose the counters so a degraded run can never
// again look like a healthy one.
// ============================================================

let worker: Worker | null = null
let isReady = false
let readyPromise: Promise<void> | null = null
let messageId = 0

type PendingCallback = {
  resolve: (data: any) => void
  reject: (error: Error) => void
}

const pending = new Map<number, PendingCallback>()

// ── Health counters ─────────────────────────────────────────
// Reset only by resetOpenCVHealth(), so they span a whole batch run.

let orbSuccessCount = 0
let orbFailureCount = 0
let orbConsecutiveFailures = 0
let workerRestartCount = 0
let orbDisabled = false
let firstOrbError: string | null = null

/** Consecutive ORB failures before we assume the worker is sick and restart it. */
const ORB_RESTART_AFTER = 3
/** How many restarts to attempt before giving up and disabling ORB for the run. */
const MAX_WORKER_RESTARTS = 3

export interface OpenCVHealth {
  orbSuccessCount: number
  orbFailureCount: number
  orbConsecutiveFailures: number
  workerRestartCount: number
  orbDisabled: boolean
  firstOrbError: string | null
}

export function getOpenCVHealth(): OpenCVHealth {
  return {
    orbSuccessCount,
    orbFailureCount,
    orbConsecutiveFailures,
    workerRestartCount,
    orbDisabled,
    firstOrbError,
  }
}

export function resetOpenCVHealth(): void {
  orbSuccessCount = 0
  orbFailureCount = 0
  orbConsecutiveFailures = 0
  workerRestartCount = 0
  orbDisabled = false
  firstOrbError = null
}

/** True if every ORB call so far has succeeded. */
export function isOrbHealthy(): boolean {
  return !orbDisabled && orbFailureCount === 0
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker('/opencv-worker.js')

    worker.onmessage = (e) => {
      const { type, id } = e.data

      // Log debug messages from worker
      if (type === 'log') {
        console.log('[OpenCV Worker]', e.data.message)
        return
      }

      if (type === 'ready') {
        isReady = true
        console.log('OpenCV Web Worker ready!')
        return
      }

      const cb = pending.get(id)
      if (!cb) return
      pending.delete(id)

      if (type === 'error') {
        cb.reject(new Error(e.data.error))
      } else {
        cb.resolve(e.data)
      }
    }

    worker.onerror = (e) => {
      console.error('OpenCV Worker error:', e)
      // A worker-level error means nothing in flight will ever be answered.
      // Reject everything rather than letting each call wait out its timeout.
      const err = new Error(`OpenCV worker crashed: ${e.message || 'unknown'}`)
      for (const [, cb] of pending) cb.reject(err)
      pending.clear()
      isReady = false
    }
  }
  return worker
}

/**
 * Tear down the worker and its OpenCV heap completely.
 * Anything in flight is rejected — callers retry rather than hang.
 */
function destroyWorker(reason: string): void {
  console.warn(`[OpenCV] Destroying worker: ${reason}`)
  if (worker) {
    try { worker.terminate() } catch { /* already gone */ }
  }
  worker = null
  isReady = false
  readyPromise = null
  const err = new Error(`OpenCV worker terminated: ${reason}`)
  for (const [, cb] of pending) cb.reject(err)
  pending.clear()
}

function sendMessage(msg: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++messageId

    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Worker message timeout'))
    }, 120000) // 2 minute timeout for heavy processing

    pending.set(id, {
      resolve: (data: any) => {
        clearTimeout(timeout)
        resolve(data)
      },
      reject: (err: Error) => {
        clearTimeout(timeout)
        reject(err)
      },
    })

    getWorker().postMessage({ ...msg, id })
  })
}

// ============================================================
// PUBLIC API
// ============================================================

export async function initOpenCV(): Promise<boolean> {
  if (isReady) return true

  if (!readyPromise) {
    readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('OpenCV Worker init timeout'))
      }, 90000)

      getWorker() // This starts the worker

      const check = () => {
        if (isReady) {
          clearTimeout(timeout)
          resolve()
        } else {
          setTimeout(check, 200)
        }
      }
      check()
    })

    readyPromise.catch(() => {
      readyPromise = null
    })
  }

  try {
    await readyPromise
    return true
  } catch (e) {
    console.error('OpenCV Worker failed to init:', e)
    return false
  }
}

export async function detectPortraits(
  imageData: Uint8ClampedArray,
  width: number,
  height: number,
  pageType: 'summary' | 'breakdown'
): Promise<{ data: number[]; width: number; height: number }[]> {
  const result = await sendMessage({
    type: 'detect_portraits',
    imageData: Array.from(imageData),
    width,
    height,
    pageType,
  })
  return result.portraits
}

/**
 * Score a portrait against a bank portrait with ORB feature matching.
 *
 * Throws on failure. Callers MUST NOT silently substitute a zero score —
 * that is exactly the behaviour that hid the heap leak for four test runs.
 * If ORB is genuinely unavailable, orbDisabled is set and the caller can
 * check isOrbHealthy() to decide whether the run is still trustworthy.
 */
export async function orbMatchScore(
  portraitData: { data: number[]; width: number; height: number },
  bankData: { data: number[]; width: number; height: number },
): Promise<number> {
  if (orbDisabled) {
    throw new Error('ORB disabled for this session after repeated worker failures')
  }

  try {
    const result = await sendMessage({ type: 'orb_match', portraitData, bankData })
    orbSuccessCount++
    orbConsecutiveFailures = 0
    return result.score
  } catch (err) {
    orbFailureCount++
    orbConsecutiveFailures++
    const msg = err instanceof Error ? err.message : String(err)
    if (firstOrbError === null) {
      firstOrbError = msg
      console.error(
        `[OpenCV] FIRST ORB FAILURE after ${orbSuccessCount} successful calls: ${msg}`
      )
    }

    if (orbConsecutiveFailures < ORB_RESTART_AFTER) throw err

    // Repeated failures: the worker's heap is probably unrecoverable.
    // Terminating it frees the whole WASM heap, leak included.
    if (workerRestartCount >= MAX_WORKER_RESTARTS) {
      orbDisabled = true
      console.error(
        `[OpenCV] ORB DISABLED after ${workerRestartCount} restarts and ` +
        `${orbFailureCount} failures. Results from this point score on ` +
        `structural+colour only — DO NOT trust them as an ORB run.`
      )
      throw err
    }

    workerRestartCount++
    destroyWorker(`${orbConsecutiveFailures} consecutive ORB failures (restart ${workerRestartCount}/${MAX_WORKER_RESTARTS})`)

    const ok = await initOpenCV()
    if (!ok) {
      orbDisabled = true
      throw new Error('OpenCV worker restart failed')
    }

    // One retry on the fresh worker. If this succeeds the counters reset
    // and the run continues on a clean heap.
    const result = await sendMessage({ type: 'orb_match', portraitData, bankData })
    orbSuccessCount++
    orbConsecutiveFailures = 0
    console.log('[OpenCV] Worker restarted successfully, ORB recovered')
    return result.score
  }
}

/** Ask the worker for its call count and current heap size. Diagnostics only. */
export async function getWorkerStats(): Promise<{ orbCallCount: number; heapBytes: number | null } | null> {
  try {
    const r = await sendMessage({ type: 'health' })
    return { orbCallCount: r.orbCallCount, heapBytes: r.heapBytes }
  } catch {
    return null
  }
}

export function isOpenCVReady(): boolean {
  return isReady
}
