'use client'

import { useEffect, useState } from 'react'
import { chartColors, type ChartColors } from '@/lib/chart-theme'
import { type ResolvedTheme } from '@/lib/theme'

// ============================================================
// useChartColors (NEXT-STEPS #16)
// ------------------------------------------------------------
// Returns the chart palette for the CURRENTLY APPLIED theme, and re-renders the
// chart when the theme changes (Settings toggle OR live OS change while on
// 'system'). Unlike the rest of the app — which re-themes purely via CSS — a
// Recharts SVG reads concrete hex at render, so it needs a React state update to
// re-colour. This hook provides that by watching the data-theme attribute on
// <html> (which lib/theme.ts sets) via a MutationObserver.
//
//   const c = useChartColors()
//   <CartesianGrid stroke={c.grid} /> ...
// ============================================================

function readApplied(): ResolvedTheme {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

export function useChartColors(): ChartColors {
  const [theme, setTheme] = useState<ResolvedTheme>(readApplied)

  useEffect(() => {
    // Sync once on mount (covers the gap between SSR default and applied theme).
    setTheme(readApplied())
    const el = document.documentElement
    const obs = new MutationObserver(() => setTheme(readApplied()))
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  return chartColors(theme)
}
