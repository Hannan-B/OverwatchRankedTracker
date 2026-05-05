'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { MatchOverview } from '@/lib/types'
import Link from 'next/link'

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-ow-panel rounded-lg p-4 border border-white/5">
      <p className="text-xs text-slate-400 font-display tracking-wider uppercase">{label}</p>
      <p className="text-2xl font-display font-bold text-white mt-1">{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
    </div>
  )
}

function ResultBadge({ result }: { result: string }) {
  const styles = {
    victory: 'bg-ow-victory/20 text-ow-victory',
    defeat: 'bg-ow-defeat/20 text-ow-defeat',
    draw: 'bg-ow-draw/20 text-ow-draw',
  }
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-display font-bold tracking-wider ${styles[result as keyof typeof styles] || ''}`}>
      {result.toUpperCase()}
    </span>
  )
}

export default function DashboardPage() {
  const [matches, setMatches] = useState<MatchOverview[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadData() {
      const { data, error } = await supabase
        .from('match_overview')
        .select('*')
        .order('played_at', { ascending: false })
        .limit(10)

      if (data) setMatches(data)
      setLoading(false)
    }
    loadData()
  }, [])

  const totalMatches = matches.length
  const wins = matches.filter(m => m.result === 'victory').length
  const losses = matches.filter(m => m.result === 'defeat').length
  const winRate = totalMatches > 0 ? Math.round((wins / totalMatches) * 100) : 0

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl text-ow-orange">Dashboard</h1>
          <p className="text-sm text-slate-400 mt-1">Your competitive overview</p>
        </div>
        <Link
          href="/upload"
          className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold
                     px-5 py-2.5 rounded-lg tracking-wider transition-colors text-sm"
        >
          + NEW MATCH
        </Link>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Matches" value={totalMatches} />
        <StatCard label="Win Rate" value={`${winRate}%`} sub={`${wins}W - ${losses}L`} />
        <StatCard
          label="Avg Elims"
          value={totalMatches > 0
            ? (matches.reduce((s, m) => s + (m.total_eliminations || 0), 0) / totalMatches).toFixed(1)
            : '—'}
        />
        <StatCard
          label="Avg Deaths"
          value={totalMatches > 0
            ? (matches.reduce((s, m) => s + (m.total_deaths || 0), 0) / totalMatches).toFixed(1)
            : '—'}
        />
      </div>

      {/* Recent matches */}
      <div>
        <h2 className="text-xl text-white mb-4">Recent Matches</h2>
        {loading ? (
          <div className="text-center py-12 text-slate-500">Loading...</div>
        ) : matches.length === 0 ? (
          <div className="text-center py-12 bg-ow-panel rounded-lg border border-white/5">
            <p className="text-slate-400 text-lg font-display">No matches recorded yet</p>
            <p className="text-slate-500 text-sm mt-2">Upload your first match photos to get started</p>
            <Link
              href="/upload"
              className="inline-block mt-4 bg-ow-orange hover:bg-ow-accent text-ow-dark
                         font-display font-bold px-6 py-2 rounded-lg tracking-wider transition-colors"
            >
              UPLOAD MATCH
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {matches.map(match => (
              <div
                key={match.id}
                className="bg-ow-panel rounded-lg p-4 border border-white/5
                           hover:border-ow-orange/30 transition-colors cursor-pointer"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <ResultBadge result={match.result} />
                    <span className="font-display text-white">{match.map}</span>
                    <span className="text-xs text-slate-500">{match.game_mode}</span>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-slate-400">
                      {match.heroes_played?.join(', ')}
                    </span>
                    <span className="text-slate-500 font-display">
                      {match.total_eliminations}/{match.total_assists}/{match.total_deaths}
                    </span>
                    <span className="text-xs text-slate-600">
                      {new Date(match.played_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
