'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { MatchOverview } from '@/lib/types'

export default function MatchesPage() {
  const [matches, setMatches] = useState<MatchOverview[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('match_overview')
        .select('*')
        .order('played_at', { ascending: false })
      if (data) setMatches(data)
      setLoading(false)
    }
    load()
  }, [])

  const resultColor = {
    victory: 'border-l-ow-victory',
    defeat: 'border-l-ow-defeat',
    draw: 'border-l-ow-draw',
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl text-ow-orange">Match History</h1>
          <p className="text-sm text-slate-400 mt-1">{matches.length} matches recorded</p>
        </div>
        <a
          href="/matches/new"
          className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold
                     px-5 py-2.5 rounded-lg tracking-wider transition-colors text-sm"
        >
          + LOG MATCH
        </a>
      </div>

      {loading ? (
        <div className="text-center py-12 text-slate-500">Loading...</div>
      ) : matches.length === 0 ? (
        <div className="text-center py-16 text-slate-500">
          <p className="font-display text-lg">No matches yet</p>
          <p className="text-sm mt-1">Upload your first match to see it here</p>
        </div>
      ) : (
        <div className="space-y-2">
          {matches.map(match => (
            <div
              key={match.id}
              className={`bg-ow-panel rounded-lg p-4 border-l-4 ${resultColor[match.result]}
                         border border-white/5 hover:border-white/10 transition-colors`}
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-display text-white font-bold">{match.map}</span>
                    <span className="text-xs text-slate-500 bg-white/5 px-2 py-0.5 rounded">
                      {match.game_mode}
                    </span>
                    <span className="text-xs text-slate-600">{match.score}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-sm text-slate-400">
                    <span>{match.heroes_played?.join(', ')}</span>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="font-display text-white">
                    {match.total_eliminations}/{match.total_assists}/{match.total_deaths}
                  </span>
                  {match.fun_rating && (
                    <span className="text-xs text-slate-500">
                      {'★'.repeat(match.fun_rating)}{'☆'.repeat(5 - match.fun_rating)}
                    </span>
                  )}
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
  )
}
