'use client'

import { useEffect, useState } from 'react'
import { type ThemeMode, themeMode, themePrefLoaded, loadThemePref, setThemeMode } from '@/lib/theme'

// ============================================================
// THEME CONTROL (NEXT-STEPS #16) — drop into the Settings page.
// ------------------------------------------------------------
// A three-way System / Light / Dark segmented control. Reads the cached mode
// (loading it if this mounts before ThemeInit ran), and writes via setThemeMode
// (which applies the theme immediately AND persists to user_settings).
//
// Styled with the ow-* tokens so it themes itself. Self-contained: import and
// render it inside the existing Settings layout — no other wiring needed.
//
//   import ThemeControl from '@/components/ThemeControl'
//   <ThemeControl />
// ============================================================

const MODES: Array<{ value: ThemeMode; label: string; hint: string }> = [
  { value: 'system', label: 'System', hint: 'Match your device' },
  { value: 'light', label: 'Light', hint: 'Always light' },
  { value: 'dark', label: 'Dark', hint: 'Always dark' },
]

export default function ThemeControl() {
  const [mode, setMode] = useState<ThemeMode>(themeMode())
  const [busy, setBusy] = useState(false)

  // If this mounts before the pref was loaded elsewhere, load it now so the
  // control reflects the stored choice rather than the default.
  useEffect(() => {
    let alive = true
    if (!themePrefLoaded()) {
      loadThemePref().then(() => { if (alive) setMode(themeMode()) })
    } else {
      setMode(themeMode())
    }
    return () => { alive = false }
  }, [])

  async function pick(next: ThemeMode) {
    if (next === mode || busy) return
    setMode(next) // optimistic; setThemeMode applies + persists
    setBusy(true)
    try {
      await setThemeMode(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <p className="text-[11px] text-ow-muted font-display tracking-wider uppercase mb-2">Theme</p>
      <div className="inline-flex rounded-xl border border-ow-line bg-ow-panel p-1 gap-1">
        {MODES.map(m => {
          const on = mode === m.value
          return (
            <button
              key={m.value}
              type="button"
              onClick={() => pick(m.value)}
              aria-pressed={on}
              title={m.hint}
              className={`px-4 py-2 rounded-lg text-xs font-display tracking-wider uppercase transition-colors
                ${on
                  ? 'bg-ow-orange text-ow-dark font-bold'
                  : 'text-ow-muted hover:text-ow-fg'}`}
            >
              {m.label}
            </button>
          )
        })}
      </div>
      <p className="text-xs text-ow-faint mt-2">
        {mode === 'system'
          ? 'Following your device’s light/dark setting.'
          : `Always ${mode}, ignoring your device setting.`}
      </p>
    </div>
  )
}
