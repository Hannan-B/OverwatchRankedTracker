'use client'

import { useEffect, useState } from 'react'
import { isLocalhost, showAlpha, setShowAlpha } from '@/lib/alpha'

// ============================================================
// ALPHA VISIBILITY TOGGLE (dev-only)
// ------------------------------------------------------------
// Renders ONLY on localhost. Flips the one global switch that decides whether
// alpha (test) matches appear across the whole app. On the live site this
// component renders nothing at all, so real users never see it and alpha is
// always excluded regardless.
//
// Place it anywhere — intended for the Settings page. Because every match-read
// goes through the alpha helper, flipping this changes every page at once.
// (A refresh / re-fetch shows the new view; we trigger a reload for simplicity.)
// ============================================================

export default function AlphaToggle() {
  const [mounted, setMounted] = useState(false)
  const [on, setOn] = useState(false)

  useEffect(() => {
    setMounted(true)
    setOn(showAlpha())
  }, [])

  // Render nothing until mounted (avoids SSR/client mismatch) and nothing at all on live.
  if (!mounted || !isLocalhost()) return null

  function toggle() {
    const next = setShowAlpha(!on)
    setOn(next)
    // Simplest correct behaviour: reload so every page re-fetches with the new rule.
    window.location.reload()
  }

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-5 py-4 flex items-center justify-between gap-3 flex-wrap">
      <div className="min-w-0">
        <p className="font-display font-bold tracking-wider text-sm text-amber-400">
          DEV · ALPHA DATA {on ? 'VISIBLE' : 'HIDDEN'}
        </p>
        <p className="text-ow-muted text-xs mt-0.5">
          {on
            ? 'Showing test (alpha) matches alongside real data. Localhost only.'
            : 'Hiding alpha matches — this is exactly what the live site shows.'}
        </p>
      </div>
      <button
        onClick={toggle}
        className="bg-ow-panel border border-ow-line text-ow-fg font-display px-4 py-2 rounded-lg tracking-wider text-xs hover:border-ow-orange/40 transition-colors whitespace-nowrap">
        {on ? 'HIDE ALPHA' : 'SHOW ALPHA'}
      </button>
    </div>
  )
}
