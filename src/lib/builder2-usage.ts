'use client'

import { supabase } from '@/lib/supabase'

// ============================================================
// FREE BUILDER USAGE TRACKING — data access (SEPARATE store)
// ------------------------------------------------------------
// Mirrors src/lib/builder-usage.ts, but for the DUAL-AXIS (Free) builder, and
// writes to its OWN tables: builder2_saved_charts + builder2_chart_views. Kept
// fully separate from the generic builder's store so the two builders can never
// collide on a config key (their chart shapes differ — this one has a free Y
// VARIABLE + a cell measure, not a fixed measure). The generic builder's save
// system is left untouched.
//
// Same behaviour: charts are SAVED by toggle (★ on/off); each revisit of a
// saved chart logs a view, so the readout shows "total views" + "distinct
// sessions returned", scopeable to a season.
// ============================================================

export interface FreeChartConfig {
  xVar: string
  yVar: string
  cellMeasure: string        // win_rate | count | avg  (for cat×cat)
  avgVar?: string | null     // only when cellMeasure === 'avg'
  chartType: string          // heatmap | bars | scatter
}

export interface FreeSavedChart {
  config_key: string
  x_var: string
  y_var: string
  cell_measure: string
  avg_var: string | null
  chart_type: string
  label: string
  created_at: string
}

export interface FreeSavedChartStats extends FreeSavedChart {
  totalViews: number
  distinctSessions: number
  lastViewedAt: string | null
}

// Deterministic key so the same combo maps to one saved row. Includes both
// axes + the cell measure (+ avg var only when it's the avg measure).
export function freeConfigKey(c: FreeChartConfig): string {
  const parts = [c.xVar, c.yVar, c.cellMeasure, c.chartType]
  if (c.cellMeasure === 'avg') parts.push(`avg:${c.avgVar ?? ''}`)
  return parts.join('|')
}

// Per-browser-session id. Own key so it's independent of the generic builder's
// session id (a session "returned to a Free chart" is its own signal).
const SESSION_KEY = 'builder2:sessionId'
export function getSessionId(): string {
  if (typeof window === 'undefined') return 'ssr'
  try {
    let id = window.sessionStorage.getItem(SESSION_KEY)
    if (!id) {
      id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      window.sessionStorage.setItem(SESSION_KEY, id)
    }
    return id
  } catch {
    return 'no-storage'
  }
}

export async function listSavedCharts(): Promise<FreeSavedChart[]> {
  const { data } = await supabase
    .from('builder2_saved_charts')
    .select('config_key, x_var, y_var, cell_measure, avg_var, chart_type, label, created_at')
    .order('created_at', { ascending: false })
  return ((data as unknown) as FreeSavedChart[] | null) || []
}

export async function isSaved(key: string): Promise<boolean> {
  const { data } = await supabase
    .from('builder2_saved_charts')
    .select('config_key')
    .eq('config_key', key)
  return (((data as unknown) as unknown[] | null) || []).length > 0
}

// Toggle save: insert if absent (returns true=now saved), delete if present
// (returns false=now unsaved). Deleting cascades the view history away.
export async function toggleSave(c: FreeChartConfig, label: string): Promise<boolean> {
  const key = freeConfigKey(c)
  const already = await isSaved(key)
  if (already) {
    await supabase.from('builder2_saved_charts').delete().eq('config_key', key)
    return false
  }
  await supabase.from('builder2_saved_charts').insert({
    config_key: key,
    x_var: c.xVar,
    y_var: c.yVar,
    cell_measure: c.cellMeasure,
    avg_var: c.cellMeasure === 'avg' ? (c.avgVar ?? null) : null,
    chart_type: c.chartType,
    label,
  })
  return true
}

// Log a revisit of a saved chart. No-op if not saved.
export async function logView(key: string): Promise<void> {
  await supabase.from('builder2_chart_views').insert({
    config_key: key,
    session_id: getSessionId(),
  })
}

// ---- Readout, optionally scoped to a date window (a season) ----
export interface SeasonWindow { start: string; end: string } // ISO dates

export async function savedChartStats(window?: SeasonWindow): Promise<FreeSavedChartStats[]> {
  const saved = await listSavedCharts()
  if (saved.length === 0) return []

  let q = supabase
    .from('builder2_chart_views')
    .select('config_key, session_id, viewed_at')
  if (window) {
    q = q.gte('viewed_at', `${window.start}T00:00:00Z`).lte('viewed_at', `${window.end}T23:59:59Z`)
  }
  const { data } = await q
  const views = (((data as unknown) as { config_key: string; session_id: string; viewed_at: string }[] | null)) || []

  const byKey = new Map<string, { total: number; sessions: Set<string>; last: string | null }>()
  for (const v of views) {
    if (!byKey.has(v.config_key)) byKey.set(v.config_key, { total: 0, sessions: new Set(), last: null })
    const agg = byKey.get(v.config_key)!
    agg.total++
    agg.sessions.add(v.session_id)
    if (!agg.last || v.viewed_at > agg.last) agg.last = v.viewed_at
  }

  return saved.map(s => {
    const agg = byKey.get(s.config_key)
    return {
      ...s,
      totalViews: agg?.total ?? 0,
      distinctSessions: agg?.sessions.size ?? 0,
      lastViewedAt: agg?.last ?? null,
    }
  })
}

// Current season from the seasons table. Mirrors Match History so scoping is
// consistent across the app.
export interface SeasonRow { id: number; name: string; start_date: string; end_date: string }
export async function getCurrentSeason(): Promise<SeasonRow | null> {
  const today = new Date().toISOString().slice(0, 10)
  const { data } = await supabase
    .from('seasons')
    .select('id, name, start_date, end_date')
    .order('start_date', { ascending: false })
  const seasons = (((data as unknown) as SeasonRow[] | null)) || []
  return seasons.find(s => s.start_date <= today && today <= s.end_date) ?? null
}
