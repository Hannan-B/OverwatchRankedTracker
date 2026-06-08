'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { formatBritishDate } from '@/lib/date-format'
import Link from 'next/link'
import { AnalyticsMenu } from '@/components/AnalyticsNav'

// ============================================================
// HOME — career-profile landing (Phase 2)
//
// Glanceable, not a dense dashboard:
//   - Four season win-rate cards: Tank(5v5)/DPS(5v5)/Support(5v5)/6v6
//   - Identity stats: total games this season + per the 4 categories
//   - Last-10 results as W/L pips
//   - Small "last 5" win-rate box
//   - Season scope toggle: current season (default) / each season / all-time
//
// Reads base `matches` for the aggregates (needs role_played, match_format,
// season_id, result) and `match_overview` for the recent-matches strip.
// ============================================================

interface SeasonRow { id: string; name: string; start_date: string; end_date: string }
interface MatchRow {
  id: string
  result: 'victory' | 'defeat' | 'draw' | null
  role_played: string | null
  match_format: '5v5' | '6v6' | null
  season_id: string | null
  played_at: string | null
  map: string | null
}

type Scope = string // a season id, or 'all'

// ---- win-rate helper for a filtered set ----
function winRate(rows: MatchRow[]): { pct: number; w: number; l: number; total: number } {
  const w = rows.filter(r => r.result === 'victory').length
  const l = rows.filter(r => r.result === 'defeat').length
  const total = rows.length
  return { pct: total ? Math.round((w / total) * 100) : 0, w, l, total }
}

// ---- one career-profile win-rate card ----
function WinRateCard({ title, rows }: { title: string; rows: MatchRow[] }) {
  const { pct, w, l, total } = winRate(rows)
  const tone = total === 0 ? 'text-slate-600'
    : pct >= 50 ? 'text-ow-victory' : 'text-ow-defeat'
  return (
    <div className="bg-ow-panel rounded-xl p-4 border border-white/5 relative overflow-hidden">
      <div aria-hidden className="absolute inset-0 opacity-40 pointer-events-none"
        style={{ background: 'radial-gradient(80% 60% at 50% 0%, rgba(249,158,26,0.06), transparent 70%)' }} />
      <p className="relative text-[11px] text-slate-400 font-display tracking-[0.15em] uppercase">{title}</p>
      <p className={`relative text-3xl font-display font-bold mt-1 ${tone}`}>
        {total === 0 ? '—' : `${pct}%`}
      </p>
      <p className="relative text-xs text-slate-500 mt-1">
        {total === 0 ? 'No games' : `${w}W – ${l}L · ${total} games`}
      </p>
    </div>
  )
}

export default function HomePage() {
  const [seasons, setSeasons] = useState<SeasonRow[]>([])
  const [scope, setScope] = useState<Scope>('all') // set to current season once known
  const [allMatches, setAllMatches] = useState<MatchRow[]>([])
  const [recent, setRecent] = useState<Array<{ id: string; result: string; map: string | null; played_at: string | null }>>([])
  const [loading, setLoading] = useState(true)
  const [currentSeasonId, setCurrentSeasonId] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)

    // Seasons (for the toggle + to find the current one)
    const { data: seasonData } = await supabase
      .from('seasons')
      .select('id, name, start_date, end_date')
      .order('start_date', { ascending: false })
    const seasonsList = (seasonData as SeasonRow[]) || []
    setSeasons(seasonsList)

    // Determine current season: the one whose range covers today.
    const today = new Date()
    const current = seasonsList.find(s =>
      new Date(s.start_date) <= today && today <= new Date(s.end_date))
    setCurrentSeasonId(current?.id ?? null)
    // Default the scope to current season if we found one, else all-time.
    setScope(prev => prev === 'all' && current ? current.id : prev)

    // All matches (aggregates computed client-side, filtered by scope)
    const { data: matchData } = await supabase
      .from('matches')
      .select('id, result, role_played, match_format, season_id, played_at, map')
      .order('played_at', { ascending: false })
    setAllMatches((matchData as MatchRow[]) || [])

    // Recent strip from the overview view (last 10 overall)
    const { data: recentData } = await supabase
      .from('match_overview')
      .select('id, result, map, played_at')
      .order('played_at', { ascending: false })
      .limit(10)
    setRecent((recentData as typeof recent) || [])

    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Filter matches to the chosen scope
  const scoped = scope === 'all'
    ? allMatches
    : allMatches.filter(m => m.season_id === scope)

  // Four category sets
  const tank5 = scoped.filter(m => m.match_format === '5v5' && m.role_played === 'tank')
  const dps5 = scoped.filter(m => m.match_format === '5v5' && m.role_played === 'dps')
  const sup5 = scoped.filter(m => m.match_format === '5v5' && m.role_played === 'support')
  const six = scoped.filter(m => m.match_format === '6v6')

  const last5 = winRate(scoped.slice(0, 5))
  const last10 = scoped.slice(0, 10)

  const scopeLabel = scope === 'all'
    ? 'All Time'
    : seasons.find(s => s.id === scope)?.name ?? 'Season'

  return (
    <div className="space-y-8 relative">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-3xl tracking-[0.12em] text-slate-100 uppercase">Home</h1>
          <p className="text-sm text-slate-500 mt-1">
            {scope === 'all' ? 'All-time overview' : `${scopeLabel} overview`}
          </p>
        </div>

        {/* Season scope toggle */}
        <div className="flex items-center gap-2 flex-wrap">
          {currentSeasonId && (
            <button
              onClick={() => setScope(currentSeasonId)}
              className={`px-3 py-1.5 rounded-lg text-xs font-display tracking-wider uppercase transition-colors
                ${scope === currentSeasonId ? 'bg-ow-orange text-ow-dark font-bold'
                  : 'bg-ow-panel text-slate-400 border border-white/10 hover:text-white'}`}
            >Current</button>
          )}
          {seasons.filter(s => s.id !== currentSeasonId).map(s => (
            <button key={s.id}
              onClick={() => setScope(s.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-display tracking-wider uppercase transition-colors
                ${scope === s.id ? 'bg-ow-orange text-ow-dark font-bold'
                  : 'bg-ow-panel text-slate-400 border border-white/10 hover:text-white'}`}
            >{s.name}</button>
          ))}
          <button
            onClick={() => setScope('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-display tracking-wider uppercase transition-colors
              ${scope === 'all' ? 'bg-ow-orange text-ow-dark font-bold'
                : 'bg-ow-panel text-slate-400 border border-white/10 hover:text-white'}`}
          >All Time</button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-16 text-slate-500 font-display tracking-wider">LOADING…</div>
      ) : (
        <>
          {/* No-season notice (if scoped to a season with no data, or no seasons set up) */}
          {scope !== 'all' && scoped.length === 0 && (
            <div className="bg-ow-panel rounded-xl border border-ow-orange/20 p-4 text-sm text-slate-400">
              No matches found for <span className="text-ow-orange">{scopeLabel}</span>.
              {seasons.length === 0 && ' No seasons are set up yet — add one in Settings → Season Management.'}
            </div>
          )}

          {/* Four win-rate cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <WinRateCard title="Tank · 5v5" rows={tank5} />
            <WinRateCard title="DPS · 5v5" rows={dps5} />
            <WinRateCard title="Support · 5v5" rows={sup5} />
            <WinRateCard title="6v6" rows={six} />
          </div>

          {/* Identity stats + last-5 box */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {/* Totals */}
            <div className="lg:col-span-2 bg-ow-panel rounded-xl p-5 border border-white/5">
              <p className="text-[11px] text-slate-400 font-display tracking-[0.15em] uppercase mb-3">Games Played</p>
              <div className="flex items-baseline gap-2 mb-4">
                <span className="text-4xl font-display font-bold text-white">{scoped.length}</span>
                <span className="text-sm text-slate-500">total</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[
                  ['Tank 5v5', tank5.length],
                  ['DPS 5v5', dps5.length],
                  ['Support 5v5', sup5.length],
                  ['6v6', six.length],
                ].map(([label, n]) => (
                  <div key={label as string} className="bg-ow-dark/60 rounded-lg p-2 text-center">
                    <p className="text-lg font-display font-bold text-slate-200">{n as number}</p>
                    <p className="text-[10px] text-slate-500 font-display tracking-wider uppercase mt-0.5">{label}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Last 5 win rate */}
            <div className="bg-ow-panel rounded-xl p-5 border border-white/5 flex flex-col justify-center">
              <p className="text-[11px] text-slate-400 font-display tracking-[0.15em] uppercase">Last 5 Matches</p>
              <p className={`text-4xl font-display font-bold mt-1 ${last5.total === 0 ? 'text-slate-600' : last5.pct >= 50 ? 'text-ow-victory' : 'text-ow-defeat'}`}>
                {last5.total === 0 ? '—' : `${last5.pct}%`}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {last5.total === 0 ? 'No recent games' : `${last5.w}W – ${last5.l}L`}
              </p>
            </div>
          </div>

          {/* Last-10 results pips */}
          <div>
            <p className="text-[11px] text-slate-400 font-display tracking-[0.15em] uppercase mb-2">Recent Form</p>
            {last10.length === 0 ? (
              <p className="text-sm text-slate-600">No matches yet.</p>
            ) : (
              <div className="flex gap-1.5">
                {last10.map(m => {
                  const c = m.result === 'victory' ? 'bg-ow-victory'
                    : m.result === 'defeat' ? 'bg-ow-defeat'
                    : 'bg-ow-draw'
                  const letter = m.result === 'victory' ? 'W' : m.result === 'defeat' ? 'L' : 'D'
                  return (
                    <div key={m.id} title={`${m.map ?? ''} · ${formatBritishDate(m.played_at)}`}
                      className={`w-8 h-8 rounded-md ${c} flex items-center justify-center
                        text-ow-dark font-display font-bold text-sm`}>
                      {letter}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Empty state for brand-new users */}
          {allMatches.length === 0 && (
            <div className="text-center py-12 bg-ow-panel rounded-xl border border-white/5">
              <p className="text-slate-300 text-lg font-display tracking-wider">No matches yet</p>
              <p className="text-slate-500 text-sm mt-2">Upload your first match from your phone to get started.</p>
              <Link href="/upload"
                className="inline-block mt-4 bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold px-6 py-2.5 rounded-lg tracking-wider transition-colors">
                UPLOAD A MATCH
              </Link>
            </div>
          )}
        </>
      )}

      {/* Analytics — surfaced here as well as at /analytics. The grouped menu is
          rendered from the shared source, so it matches the Analytics overview. */}
      <div className="pt-2">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="font-display text-xl tracking-[0.12em] text-slate-100 uppercase">Analytics</h2>
          <Link href="/analytics" className="text-xs text-slate-500 hover:text-ow-orange font-display tracking-wider uppercase">
            open full area →
          </Link>
        </div>
        <AnalyticsMenu compact />
      </div>
    </div>
  )
}
