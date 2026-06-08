'use client'

import { supabase } from '@/lib/supabase'

// ============================================================
// BUILDER USAGE TRACKING — data access
// ------------------------------------------------------------
// Talks to builder_saved_charts + builder_chart_views. Keeps all the storage
// detail out of the builder page. Charts are SAVED by toggle (star on/off);
// each OPEN/revisit of a saved chart logs a view, so the readout can show
// "total views" and "distinct sessions returned", scopeable to a season.
// ============================================================

export interface ChartConfig {
  xVar: string
  measure: string
  chartType: string
  avgVar?: string | null
  yVar?: string | null
}

export interface SavedChart {
  config_key: string
  x_var: string
  measure: string
  chart_type: string
  avg_var: string | null
  y_var: string | null
  label: string
  created_at: string
}

export interface SavedChartStats extends SavedChart {
  totalViews: number
  distinctSessions: number
  lastViewedAt: string | null
}

// Deterministic key for a config so the same combo maps to one saved row.
// Only the fields that change the chart's meaning are included (avg_var only
// matters for the avg measure; y_var only for xy/scatter).
export function configKey(c: ChartConfig): string {
  const parts = [c.xVar, c.measure, c.chartType]
  if (c.measure === 'avg') parts.push(`avg:${c.avgVar ?? ''}`)
  if (c.measure === 'xy') parts.push(`y:${c.yVar ?? ''}`)
  return parts.join('|')
}

// A per-browser-session id so "distinct sessions" is countable without any
// auth/user table. Stable for the life of one tab session; a new tab/session
// gets a new id. (sessionStorage, not localStorage, so it resets per session —
// which is exactly the "returned on a separate session" signal §8 wants.)
const SESSION_KEY = 'builder:sessionId'
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

// List all saved charts (config + when saved).
export async function listSavedCharts(): Promise<SavedChart[]> {
  const { data } = await supabase
    .from('builder_saved_charts')
    .select('config_key, x_var, measure, chart_type, avg_var, y_var, label, created_at')
    .order('created_at', { ascending: false })
  return ((data as unknown) as SavedChart[] | null) || []
}

// Is a given config currently saved?
export async function isSaved(key: string): Promise<boolean> {
  const { data } = await supabase
    .from('builder_saved_charts')
    .select('config_key')
    .eq('config_key', key)
  return (((data as unknown) as unknown[] | null) || []).length > 0
}

// Toggle save: insert if absent (returns true=now saved), delete if present
// (returns false=now unsaved). Deleting cascades the view history away.
export async function toggleSave(c: ChartConfig, label: string): Promise<boolean> {
  const key = configKey(c)
  const already = await isSaved(key)
  if (already) {
    await supabase.from('builder_saved_charts').delete().eq('config_key', key)
    return false
  }
  await supabase.from('builder_saved_charts').insert({
    config_key: key,
    x_var: c.xVar,
    measure: c.measure,
    chart_type: c.chartType,
    avg_var: c.measure === 'avg' ? (c.avgVar ?? null) : null,
    y_var: c.measure === 'xy' ? (c.yVar ?? null) : null,
    label,
  })
  return true
}

// Log a revisit of a saved chart. No-op (silently) if the chart isn't saved —
// we only track views of charts you've flagged.
export async function logView(key: string): Promise<void> {
  await supabase.from('builder_chart_views').insert({
    config_key: key,
    session_id: getSessionId(),
  })
}

// ---- Readout, optionally scoped to a date window (a season) ----
export interface SeasonWindow { start: string; end: string } // ISO dates

export async function savedChartStats(window?: SeasonWindow): Promise<SavedChartStats[]> {
  const saved = await listSavedCharts()
  if (saved.length === 0) return []

  let q = supabase
    .from('builder_chart_views')
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

// Current season from the seasons table (today within start/end). Mirrors the
// Match History logic so scoping is consistent across the app.
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
