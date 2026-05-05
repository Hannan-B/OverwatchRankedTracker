'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { HeroAnalytics } from '@/lib/types'

export default function HeroesPage() {
  const [heroData, setHeroData] = useState<HeroAnalytics[]>([])
  const [loading, setLoading] = useState(true)
  const [roleFilter, setRoleFilter] = useState<string>('all')

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('hero_analytics')
        .select('*')
        .order('times_played', { ascending: false })
      if (data) setHeroData(data)
      setLoading(false)
    }
    load()
  }, [])

  const filtered = roleFilter === 'all'
    ? heroData
    : heroData.filter(h => h.role_played === roleFilter)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl text-ow-orange">Hero Analytics</h1>
        <p className="text-sm text-slate-400 mt-1">Performance breakdown by hero</p>
      </div>

      {/* Role filter */}
      <div className="flex gap-2">
        {['all', 'tank', 'dps', 'support'].map(role => (
          <button
            key={role}
            onClick={() => setRoleFilter(role)}
            className={`px-4 py-1.5 rounded-lg text-sm font-display tracking-wider transition-colors
              ${roleFilter === role
                ? 'bg-ow-orange text-ow-dark font-bold'
                : 'bg-ow-panel text-slate-400 hover:text-white border border-white/5'
              }`}
          >
            {role.toUpperCase()}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12 text-slate-500">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-500">
          <p className="font-display text-lg">No hero data yet</p>
          <p className="text-sm mt-1">Play some matches to see hero analytics</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(hero => (
            <div
              key={`${hero.hero_name}-${hero.role_played}`}
              className="bg-ow-panel rounded-lg p-4 border border-white/5
                         hover:border-ow-orange/30 transition-colors"
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-display text-white text-lg">{hero.hero_name}</h3>
                <span className={`text-sm font-display font-bold
                  ${hero.win_rate >= 55 ? 'text-ow-victory' :
                    hero.win_rate <= 45 ? 'text-ow-defeat' : 'text-ow-draw'}`}>
                  {hero.win_rate}%
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-lg font-display text-white">{hero.times_played}</p>
                  <p className="text-xs text-slate-500">PLAYED</p>
                </div>
                <div>
                  <p className="text-lg font-display text-ow-victory">{hero.wins}</p>
                  <p className="text-xs text-slate-500">WINS</p>
                </div>
                <div>
                  <p className="text-lg font-display text-ow-defeat">{hero.losses}</p>
                  <p className="text-xs text-slate-500">LOSSES</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
