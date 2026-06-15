'use client'

import { useEffect } from 'react'
import { loadThemePref, watchSystemTheme } from '@/lib/theme'

// ============================================================
// THEME INIT (NEXT-STEPS #16)
// ------------------------------------------------------------
// Mount once, high in the tree (e.g. inside AuthGate's signed-in branch, or at
// the top of the app shell). It:
//   1. Loads the stored theme_mode from user_settings and applies it (reconciles
//      with the no-FOUC bootstrap that already set a sensible first-paint theme).
//   2. While the mode is 'system', keeps the applied theme in sync with live OS
//      light/dark changes.
// Renders nothing.
// ============================================================

export default function ThemeInit() {
  useEffect(() => {
    loadThemePref()
    const unwatch = watchSystemTheme()
    return unwatch
  }, [])
  return null
}
