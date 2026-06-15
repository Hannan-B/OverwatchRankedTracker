'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { showAlpha } from '@/lib/alpha'
import { formatBritishDateTime } from '@/lib/date-format'
import { useRouter } from 'next/navigation'
import type { Match, ScoreboardPlayer, HeroPerformance, HeroStat } from '@/lib/types'

// ============================================================
// MATCH DETAIL — /matches/[id]  (Phase 2 — v2)
// Single scrollable page (no tabs): Summary, Hero Breakdown, Scoreboard.
// - No ally/enemy comps.
// - Scoreboard: portraits + blue(ally)/red(enemy) borders; YOUR row shows your
//   gamertag, others show hero name; YOUR row highlighted; thousands separators.
// - Higher-contrast text throughout.
// ============================================================

const HERO_FILENAME_MAP: Record<string, string> = {
  'Soldier: 76': 'Soldier_76', 'Torbjörn': 'Torbjorn_safe', 'Lúcio': 'Lucio_safe',
}
function heroPortrait(name: string | null): string | null {
  if (!name) return null
  return `/heroes/${HERO_FILENAME_MAP[name] || name}.png`
}
function num(n: number | null): string {
  if (n == null) return '—'
  return n.toLocaleString('en-GB') // thousands separators e.g. 12,345
}
function resultTone(r: string) {
  return r === 'victory' ? 'text-ow-victory' : r === 'defeat' ? 'text-ow-defeat' : 'text-ow-draw'
}

function HeroImg({ name, border }: { name: string | null; border?: 'ally' | 'enemy' }) {
  const src = heroPortrait(name)
  const ring = border === 'ally' ? 'border-blue-400' : border === 'enemy' ? 'border-red-400' : 'border-ow-line'
  return (
    <div className={`w-10 h-10 rounded-lg overflow-hidden bg-ow-dark border-2 ${ring} shrink-0`}>
      {src
        ? <img src={src} alt={name || ''} className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
        : <div className="w-full h-full" />}
    </div>
  )
}

export default function MatchDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const matchId = Number(params.id)
  const [match, setMatch] = useState<Match | null>(null)
  const [players, setPlayers] = useState<ScoreboardPlayer[]>([])
  const [perfs, setPerfs] = useState<HeroPerformance[]>([])
  const [statsByPerf, setStatsByPerf] = useState<Record<number, HeroStat[]>>({})
  const [gamertag, setGamertag] = useState<string>('You')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const { data: m } = await supabase.from('matches').select('*').eq('id', matchId).single()
    // Alpha guard (#13b): test matches must not be reachable by URL on live.
    // The list views already exclude them (matchQuery), but this page fetches by
    // raw id, so guard here: off-localhost (or switch off), an alpha match is
    // treated as not-found rather than rendered.
    const matchRow = m as (Match & { is_alpha?: boolean }) | null
    if (matchRow?.is_alpha && !showAlpha()) {
      setMatch(null)
      setLoading(false)
      return
    }
    setMatch(matchRow)

    const { data: sb } = await supabase.from('scoreboard_players')
      .select('*').eq('match_id', matchId).order('slot', { ascending: true })
    setPlayers((sb as ScoreboardPlayer[]) || [])

    const { data: hp } = await supabase.from('hero_performances')
      .select('*').eq('match_id', matchId).order('display_order', { ascending: true })
    const perfRows = (hp as HeroPerformance[]) || []
    setPerfs(perfRows)
    if (perfRows.length > 0) {
      const ids = perfRows.map(p => p.id)
      const { data: hs } = await supabase.from('hero_stats').select('*').in('hero_performance_id', ids)
      const grouped: Record<number, HeroStat[]> = {}
      ;(hs as HeroStat[] | null)?.forEach(s => { (grouped[s.hero_performance_id] ||= []).push(s) })
      setStatsByPerf(grouped)
    }

    const { data: us } = await supabase.from('user_settings').select('gamertag').limit(1).single()
    if (us?.gamertag) setGamertag(us.gamertag)

    setLoading(false)
  }, [matchId])

  useEffect(() => { load() }, [load])

  const allies = players.filter(p => p.team === 'ally')
  const enemies = players.filter(p => p.team === 'enemy')

  return (
    <div className="space-y-6">
      <button onClick={() => router.back()}
        className="text-ow-muted hover:text-ow-orange text-sm font-display tracking-wider transition-colors">
        ← BACK TO MATCHES
      </button>

      {loading ? (
        <div className="text-center py-12 text-ow-muted font-display tracking-wider">LOADING…</div>
      ) : !match ? (
        <div className="text-center py-12 text-ow-muted">Match not found.</div>
      ) : (
        <>
          {/* Header */}
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="font-display text-3xl tracking-[0.1em] text-ow-fg uppercase">{match.map}</h1>
              <span className={`font-display text-xl font-bold ${resultTone(match.result)}`}>{match.result.toUpperCase()}</span>
            </div>
            <p className="text-sm text-ow-muted mt-1">
              {match.game_mode} · {match.match_format} · {match.score} · {formatBritishDateTime(match.played_at)}
            </p>
          </div>

          {/* SUMMARY */}
          <section className="space-y-3">
            <h2 className="font-display text-sm tracking-[0.2em] text-ow-orange uppercase">Summary</h2>
            <div className="grid grid-cols-3 gap-3">
              {[
                ['Eliminations', match.total_eliminations],
                ['Assists', match.total_assists],
                ['Deaths', match.total_deaths],
              ].map(([label, val]) => (
                <div key={label as string} className="bg-ow-panel rounded-xl p-4 border border-ow-line text-center">
                  <p className="text-3xl font-display font-bold text-ow-fg">{num(val as number | null)}</p>
                  <p className="text-xs text-ow-muted font-display tracking-wider uppercase mt-1">{label}</p>
                </div>
              ))}
            </div>
            <div className="bg-ow-panel rounded-xl p-5 border border-ow-line space-y-2 text-sm">
              <Row label="Role" value={match.role_played?.toUpperCase()} />
              <Row label="Format" value={match.match_format} />
              {match.starting_side && <Row label="Started on" value={match.starting_side === 'attack' ? 'Attack' : 'Defense'} />}
              {match.game_length_seconds != null && (
                <Row label="Length" value={`${Math.floor(match.game_length_seconds / 60)}:${String(match.game_length_seconds % 60).padStart(2, '0')}`} />
              )}
              {match.fun_rating != null && (
                <Row label="Fun" value={<span className="text-ow-orange">{'★'.repeat(match.fun_rating)}<span className="text-ow-faint">{'★'.repeat(5 - match.fun_rating)}</span></span>} />
              )}
              {match.personal_thoughts && (
                <div className="pt-2 border-t border-ow-line">
                  <p className="text-xs text-ow-muted font-display tracking-wider uppercase mb-1">Notes</p>
                  <p className="text-ow-fg">{match.personal_thoughts}</p>
                </div>
              )}
            </div>
          </section>

          {/* HERO BREAKDOWN */}
          <section className="space-y-3">
            <h2 className="font-display text-sm tracking-[0.2em] text-ow-orange uppercase">Hero Breakdown</h2>
            {perfs.length === 0 ? (
              <p className="text-ow-muted text-sm">No hero breakdown recorded for this match.</p>
            ) : perfs.map(p => (
              <div key={p.id} className="bg-ow-panel rounded-xl p-4 border border-ow-line">
                <div className="flex items-center gap-3 mb-3">
                  <HeroImg name={p.hero_name} />
                  <div className="flex-1 min-w-0">
                    <p className="font-display text-ow-fg tracking-wider text-base">{p.hero_name}</p>
                    <p className="text-xs text-ow-muted">
                      {p.percent_played != null ? `${p.percent_played}% played` : ''}
                      {p.play_time_seconds != null ? ` · ${Math.floor(p.play_time_seconds / 60)}:${String(p.play_time_seconds % 60).padStart(2, '0')}` : ''}
                    </p>
                  </div>
                </div>
                {(statsByPerf[p.id] || []).length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {(statsByPerf[p.id] || []).map((s, i) => (
                      <div key={i} className="bg-ow-dark/70 rounded-lg px-3 py-2">
                        <p className="text-[11px] text-ow-muted font-display tracking-wider uppercase truncate">{s.stat_name}</p>
                        <p className="text-sm text-ow-fg font-display">{s.stat_value}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </section>

          {/* SCOREBOARD */}
          <section className="space-y-3">
            <h2 className="font-display text-sm tracking-[0.2em] text-ow-orange uppercase">Scoreboard</h2>
            {players.length === 0 ? (
              <p className="text-ow-muted text-sm">No scoreboard recorded for this match.</p>
            ) : (
              <>
                <ScoreTable title="Your Team" team="ally" players={allies} gamertag={gamertag} />
                <ScoreTable title="Enemy Team" team="enemy" players={enemies} gamertag={gamertag} />
              </>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <span className="text-ow-muted">{label}</span>
      <span className="text-ow-fg font-display">{value}</span>
    </div>
  )
}

function ScoreTable({ title, team, players, gamertag }: {
  title: string; team: 'ally' | 'enemy'; players: ScoreboardPlayer[]; gamertag: string
}) {
  const accent = team === 'ally' ? 'text-blue-400' : 'text-red-400'
  return (
    <div className="bg-ow-panel rounded-xl border border-ow-line overflow-hidden">
      <div className={`px-4 py-2 border-b border-ow-line font-display text-xs tracking-[0.15em] uppercase ${accent}`}>{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] text-ow-muted font-display tracking-wider uppercase">
              <th className="text-left font-normal px-3 py-2">Player</th>
              <th className="text-right font-normal px-2 py-2">E</th>
              <th className="text-right font-normal px-2 py-2">A</th>
              <th className="text-right font-normal px-2 py-2">D</th>
              <th className="text-right font-normal px-2 py-2">DMG</th>
              <th className="text-right font-normal px-2 py-2">H</th>
              <th className="text-right font-normal px-3 py-2">MIT</th>
            </tr>
          </thead>
          <tbody>
            {players.map(p => (
              <tr key={p.id} className={`border-t border-ow-line ${p.is_user ? 'bg-ow-orange/15' : ''}`}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <HeroImg name={p.hero_name} border={team} />
                    <span className={`font-display ${p.is_user ? 'text-ow-orange font-bold' : 'text-ow-fg'}`}>
                      {p.is_user ? gamertag : (p.hero_name || '—')}
                    </span>
                  </div>
                </td>
                <td className="text-right px-2 py-2 text-ow-fg">{num(p.eliminations)}</td>
                <td className="text-right px-2 py-2 text-ow-fg">{num(p.assists)}</td>
                <td className="text-right px-2 py-2 text-ow-fg">{num(p.deaths)}</td>
                <td className="text-right px-2 py-2 text-ow-fg">{num(p.damage)}</td>
                <td className="text-right px-2 py-2 text-ow-fg">{num(p.healing)}</td>
                <td className="text-right px-3 py-2 text-ow-fg">{num(p.mitigation)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
