// ============================================================
// OPENCV WORKER CLIENT
// Manages the Web Worker that runs OpenCV.js in isolation
// All OpenCV operations go through this client
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
    }
  }
  return worker
}

function sendMessage(msg: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++messageId
    pending.set(id, { resolve, reject })

    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Worker message timeout'))
    }, 120000) // 2 minute timeout for heavy processing

    const originalResolve = resolve
    pending.set(id, {
      resolve: (data: any) => {
        clearTimeout(timeout)
        originalResolve(data)
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

export async function orbMatchScore(
  portraitData: { data: number[]; width: number; height: number },
  bankData: { data: number[]; width: number; height: number },
): Promise<number> {
  const result = await sendMessage({
    type: 'orb_match',
    portraitData,
    bankData,
  })
  return result.score
}

export function isOpenCVReady(): boolean {
  return isReady
}
