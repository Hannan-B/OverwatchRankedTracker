// Loads OpenCV.js from our own public folder (self-hosted, no CDN dependency)
// The opencv.js file is served by Next.js/Vercel alongside the app

let loadPromise: Promise<any> | null = null

export function loadOpenCV(): Promise<any> {
  if (loadPromise) return loadPromise

  // Already loaded and ready?
  if (typeof window !== 'undefined' && (window as any).cv?.Mat) {
    return Promise.resolve((window as any).cv)
  }

  loadPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      loadPromise = null
      reject(new Error('OpenCV.js initialization timed out'))
    }, 60000)

    // Set up the callback BEFORE loading the script
    ;(window as any).cv = (window as any).cv || {}
    ;(window as any).cv.onRuntimeInitialized = () => {
      clearTimeout(timeout)
      console.log('OpenCV.js ready!')
      resolve((window as any).cv)
    }

    const script = document.createElement('script')
    script.src = '/opencv.js'  // Self-hosted from public folder
    script.async = true

    script.onerror = () => {
      clearTimeout(timeout)
      loadPromise = null
      reject(new Error('Failed to load OpenCV.js'))
    }

    console.log('Loading OpenCV.js (self-hosted)...')
    document.head.appendChild(script)
  })

  return loadPromise
}
