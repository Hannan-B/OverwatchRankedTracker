'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import AnalyticsFilters, {
  DEFAULT_FILTERS,
  type AnalyticsFilterState,
  type SeasonOption,
} from '@/components/AnalyticsFilters'
import { AnalyticsNav, AnalyticsHeader } from '@/components/AnalyticsNav'
import { supabase } from '@/lib/supabase'
import Select from '@/components/Select'
import { matchQuery } from '@/lib/alpha'
import { loadLeaverPref, showLeaverGames } from '@/lib/leaver'
import { defaultSeasonSelection } from '@/lib/season-util'
import {
  buildLineups, soloBaselines, aggregateCombos, liftFromBase, pairingMatrix,
  playedHeroes, CONFIDENCE_MIN_GAMES,
  type HeroPlayRow, type ComboFilters, type ComboMode,
  type MatchLineup, type ComboStat, type HeroStat, type PairingMatrix,
} from './hero-pairings-lib'

// ============================================================
// HERO PAIRINGS — the hero combinations you play, and how they perform.
// ------------------------------------------------------------
// Answers "do I win more as Reaper+Mei or Reaper+Cassidy?" — combinations of
// heroes *I* play within a match, keyed on my own hero rows. Distinct from Hero
// Matchups (which is about OTHER players' heroes vs my anchor) and from the
// Heroes page (general per-hero performance).
//
// Data: hero_match_facts (one row per hero I played >=60s in a match). A match's
// "lineup" is the set of my heroes with percent_played >= a slider threshold.
// Alpha test matches are excluded via match_id against the matches table (the
// hero view carries no is_alpha column — same approach the builder uses).
// ============================================================

// Columns we read off hero_match_facts (mirrors the live view; NO is_alpha).
const HERO_COLS =
  'match_id, hero_name, percent_played, match_format, ' +
  'game_mode, map, starting_side, result'

const OW = {
  orange: '#f99e1a', accent: '#ffcb6b', victory: '#3fb950', defeat: '#f85149',
  draw: '#8b949e',
}

// Raw shapes off the two reads.
interface RawHeroRow {
  match_id: number
  hero_name: string
  percent_played: number | string | null
  match_format: '5v5' | '6v6'
  game_mode: string | null
  map: string | null
  starting_side: 'attack' | 'defense' | null
  result: 'victory' | 'defeat' | 'draw'
}
interface RawMatchRow { id: number; team_leaver?: boolean | null; enemy_leaver?: boolean | null; season_id?: number | null }

const selectCls =
  'bg-ow-dark border border-ow-line rounded-xl px-3 py-2 text-sm text-ow-fg ' +
  'font-display tracking-wider focus:border-ow-orange focus:outline-none transition-colors ' +
  '[color-scheme:dark]'
const labelCls = 'text-[11px] text-ow-muted font-display tracking-wider uppercase'

// Win-rate → cell tint (green high, red low), matching the Matchups matrix.
function rateColor(winRate: number | null): string {
  if (winRate === null) return 'transparent'
  const t = Math.max(0, Math.min(1, winRate / 100))
  // red (low) → amber (mid) → green (high)
  const from = [248, 81, 73]    // defeat red
  const mid = [249, 158, 26]    // orange
  const to = [63, 185, 80]      // victory green
  const lerp = (a: number[], b: number[], u: number) => a.map((x, i) => Math.round(x + (b[i] - x) * u))
  const c = t < 0.5 ? lerp(from, mid, t / 0.5) : lerp(mid, to, (t - 0.5) / 0.5)
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}
function rateText(winRate: number | null): string {
  if (winRate === null) return '#475569'
  return '#0f1419'
}
function fmtRate(r: number | null): string {
  return r === null ? '·' : `${r}%`
}
function fmtDelta(d: number | null): string {
  if (d === null) return '—'
  const sign = d > 0 ? '+' : ''
  return `${sign}${d}`
}

export default function AnalyticsHeroesOverviewPage() {
  const [filters, setFilters] = useState<AnalyticsFilterState>(DEFAULT_FILTERS)
  const [heroRows, setHeroRows] = useState<RawHeroRow[]>([])
  const [visibleIds, setVisibleIds] = useState<Set<number>>(new Set())
  const [seasonOptions, setSeasonOptions] = useState<SeasonOption[]>([])
  // match_id → season_id, so the season filter can apply reactively (the season
  // checkboxes are an in-page control, unlike leaver which is baked into visibleIds).
  const [seasonByMatch, setSeasonByMatch] = useState<Map<number, number | null>>(new Map())
  const [loading, setLoading] = useState(true)
  const seasonDefaulted = useRef(false)

  // ---- Pairings controls ----
  const [threshold, setThreshold] = useState<number>(20) // percent_played floor
  const [mode, setMode] = useState<ComboMode>('cooccurrence')
  const [minSize, setMinSize] = useState<number>(2)       // 1 includes solos
  const [matrixSel, setMatrixSel] = useState<string[]>([])
  const [base, setBase] = useState<string[]>([])          // lift drill-down base

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      matchQuery('id, team_leaver, enemy_leaver, season_id').order('played_at', { ascending: false }),
      supabase.from('hero_match_facts').select(HERO_COLS),
      supabase.from('seasons').select('id, name, start_date, end_date').order('start_date', { ascending: false }),
    ]).then(async ([mRes, hRes, sRes]) => {
      if (cancelled) return
      const m = (((mRes as unknown) as { data: RawMatchRow[] | null }).data) || []
      const h = (((hRes as unknown) as { data: RawHeroRow[] | null }).data) || []
      await loadLeaverPref()
      // visibleIds gates playRows (→ lineups/combos/lift/matrix). Pairings is a
      // performance surface, so leaver games are excluded unless the switch is on.
      const showLeavers = showLeaverGames()
      const kept = m.filter(r => showLeavers || (r.team_leaver !== true && r.enemy_leaver !== true))
      setVisibleIds(new Set(kept.map(r => r.id)))
      setSeasonByMatch(new Map(m.map(r => [r.id, r.season_id ?? null])))
      const seasonRows = (((sRes as unknown) as { data: { id: number; name: string; start_date: string; end_date: string }[] | null }).data) || []
      setSeasonOptions(seasonRows.map(s => ({ id: s.id, name: s.name })))
      if (!seasonDefaulted.current) {
        seasonDefaulted.current = true
        setFilters(f => ({ ...f, seasons: defaultSeasonSelection(seasonRows) }))
      }
      setHeroRows(h)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  // Map the shared filter state → ComboFilters. Queue's 5v5/6v6 split maps to
  // format; a 5v5 role can't be enforced on hero grain (no role column), so the
  // role part of Queue is ignored here — same limitation as the builder's hero
  // grain. Mode + Map apply directly.
  const comboFilters: ComboFilters = useMemo(() => ({
    format: filters.queue === '6v6' ? '6v6' : (filters.queue === 'all' ? 'all' : '5v5'),
    mode: filters.mode === 'all' ? 'all' : filters.mode,
    map: filters.map === '' ? 'all' : filters.map,
  }), [filters])

  // Alpha-excluded + leaver-excluded (via visibleIds) hero rows, then the season
  // filter applied reactively → typed HeroPlayRow. seasons=[] means All Time.
  const playRows: HeroPlayRow[] = useMemo(() => {
    const seasonSel = filters.seasons
    const seasonOk = (matchId: number) => {
      if (seasonSel.length === 0) return true // All Time
      const sid = seasonByMatch.get(matchId) ?? null
      return sid != null && seasonSel.includes(sid)
    }
    return heroRows
      .filter(r => visibleIds.has(r.match_id) && seasonOk(r.match_id))
      .map(r => ({
        match_id: r.match_id,
        hero_name: r.hero_name,
        percent_played: r.percent_played == null ? null : Number(r.percent_played),
        result: r.result,
        match_format: r.match_format,
        game_mode: r.game_mode,
        map: r.map,
        starting_side: r.starting_side,
      }))
  }, [heroRows, visibleIds, seasonByMatch, filters.seasons])

  const lineups: MatchLineup[] = useMemo(
    () => buildLineups(playRows, comboFilters, threshold),
    [playRows, comboFilters, threshold]
  )
  const solo: Map<string, HeroStat> = useMemo(() => soloBaselines(lineups), [lineups])
  const combos: ComboStat[] = useMemo(
    () => aggregateCombos(lineups, solo, mode, minSize, 6),
    [lineups, solo, mode, minSize]
  )
  const heroesPlayed = useMemo(() => playedHeroes(lineups), [lineups])

  // Default the matrix selection to the top ~6 most-played heroes once data loads.
  useEffect(() => {
    if (heroesPlayed.length && matrixSel.length === 0) {
      setMatrixSel(heroesPlayed.slice(0, 6).map(h => h.hero))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroesPlayed])

  const matrix: PairingMatrix | null = useMemo(
    () => (matrixSel.length ? pairingMatrix(lineups, matrixSel) : null),
    [lineups, matrixSel]
  )

  const liftResult = useMemo(
    () => (base.length ? liftFromBase(lineups, base) : null),
    [lineups, base]
  )

  // Top combos by win rate (confident first), then by lift.
  const rankedCombos = useMemo(() => {
    return [...combos].sort((a, b) => {
      if (a.lowConfidence !== b.lowConfidence) return a.lowConfidence ? 1 : -1
      return (b.winRate ?? -1) - (a.winRate ?? -1) || b.games - a.games
    })
  }, [combos])

  const totalGames = lineups.length
  const confidentCombos = combos.filter(c => !c.lowConfidence).length

  function toggleMatrixHero(hero: string) {
    setMatrixSel(sel => sel.includes(hero) ? sel.filter(h => h !== hero) : [...sel, hero])
  }

  return (
    <div className="space-y-6">
      <AnalyticsHeader title="Hero Pairings" subtitle="The hero combinations you play, and how they perform." />
      <AnalyticsNav />

      <AnalyticsFilters
        value={filters}
        onChange={setFilters}
        show={{ queue: true, mode: true, map: true, hero: false, season: true }}
        seasonOptions={seasonOptions}
      />

      {/* ============ HERO PAIRINGS (your own combinations) ============ */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <div className="h-1 w-10 bg-ow-orange rounded-full" />
          <h2 className="font-display tracking-[0.15em] text-ow-fg uppercase text-sm">
            Hero pairings — your own combinations
          </h2>
        </div>
        <p className="text-sm text-ow-muted max-w-3xl">
          Which heroes <em>you</em> play together in a match, and how those combinations do.
          The diagonal of the grid is each hero on its own (your solo baseline); every other
          cell is your win rate when you played both heroes in the same game.
        </p>

        {/* Controls */}
        <div className="bg-ow-panel rounded-xl border border-ow-line p-4">
          <div className="flex flex-wrap items-end gap-5">
            <label className="flex flex-col gap-1">
              <span className={labelCls}>Counting</span>
              <Select<ComboMode>
                className={selectCls}
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'cooccurrence', label: 'Played both (co-occurrence)' },
                  { value: 'exact', label: 'Exact line-up only' },
                ]}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className={labelCls}>Combination size</span>
              <Select<number>
                className={selectCls}
                value={minSize}
                onChange={setMinSize}
                options={[
                  { value: 1, label: 'Solo & up (incl. baselines)' },
                  { value: 2, label: 'Pairs & up' },
                  { value: 3, label: 'Trios & up' },
                ]}
              />
            </label>

            <label className="flex flex-col gap-1 min-w-[220px]">
              <span className={labelCls}>
                Hero counts if played ≥ <span className="text-ow-orange">{threshold}%</span> of the game
              </span>
              <input
                type="range" min={0} max={90} step={5}
                value={threshold}
                onChange={e => setThreshold(Number(e.target.value))}
                className="accent-ow-orange"
              />
            </label>

            <div className="flex flex-col gap-1">
              <span className={labelCls}>In view</span>
              <span className="text-sm text-ow-fg font-display tracking-wider py-2">
                {totalGames} game{totalGames === 1 ? '' : 's'} · {confidentCombos} combo{confidentCombos === 1 ? '' : 's'} ≥{CONFIDENCE_MIN_GAMES}
              </span>
            </div>
          </div>
          <p className="text-[11px] text-ow-faint mt-3">
            Sliding the threshold up drops short hero stints — a 10%-played hero won&apos;t count toward a combo,
            so the same game can move between combos as you slide. Combos under {CONFIDENCE_MIN_GAMES} games are dimmed.
          </p>
        </div>

        {loading ? (
          <div className="bg-ow-panel rounded-xl border border-ow-line p-10 text-center text-ow-muted font-display tracking-wider">
            LOADING…
          </div>
        ) : totalGames === 0 ? (
          <div className="bg-ow-panel rounded-xl border border-ow-line p-10 text-center">
            <p className="font-display tracking-wider text-ow-muted uppercase text-sm">No games</p>
            <p className="text-sm text-ow-faint mt-1">No matches fit these filters at this threshold.</p>
          </div>
        ) : (
          <>
            {/* Matrix */}
            <div className="bg-ow-panel rounded-xl border border-ow-line p-4">
              <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
                <h3 className="font-display tracking-[0.12em] text-ow-fg uppercase text-sm">Pairing grid</h3>
                <span className="text-xs text-ow-faint font-display tracking-wider">
                  win rate · diagonal = solo
                </span>
              </div>

              {/* hero toggles */}
              <div className="flex flex-wrap gap-1.5 mb-4">
                {heroesPlayed.map(({ hero, games }) => {
                  const on = matrixSel.includes(hero)
                  return (
                    <button
                      key={hero}
                      onClick={() => toggleMatrixHero(hero)}
                      className={`text-[11px] font-display tracking-wider rounded-lg px-2.5 py-1 border transition-colors ${
                        on
                          ? 'bg-ow-orange text-ow-dark border-ow-orange font-bold'
                          : 'bg-ow-dark text-ow-muted border-ow-line hover:border-ow-orange/50'
                      }`}
                      title={`${games} game${games === 1 ? '' : 's'}`}>
                      {hero}
                    </button>
                  )
                })}
              </div>

              {matrix && matrix.heroes.length > 0 ? (
                <div className="overflow-auto max-h-[520px]">
                  <table className="border-separate" style={{ borderSpacing: 3 }}>
                    <thead>
                      <tr>
                        <th className="sticky top-0 left-0 z-20 bg-ow-panel" />
                        {matrix.heroes.map(h => (
                          <th key={h}
                            className="sticky top-0 z-10 bg-ow-panel px-2 py-1 text-[10px] font-display tracking-wider
                              text-ow-muted uppercase whitespace-nowrap align-bottom">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {matrix.heroes.map((rh, i) => (
                        <tr key={rh}>
                          <th className="sticky left-0 z-10 bg-ow-panel pr-2 text-[10px] font-display tracking-wider
                            text-ow-muted uppercase whitespace-nowrap text-right">
                            {rh}
                          </th>
                          {matrix.heroes.map((ch, j) => {
                            const c = matrix.cells[i][j]
                            const faded = c.lowConfidence && c.games > 0
                            return (
                              <td key={ch}
                                title={`${rh}${c.isDiagonal ? ' (solo)' : ' + ' + ch}\n${fmtRate(c.winRate)} · ${c.games} game${c.games === 1 ? '' : 's'}`}
                                className="text-center rounded-md"
                                style={{
                                  minWidth: 52, height: 42,
                                  background: rateColor(c.winRate),
                                  color: rateText(c.winRate),
                                  opacity: c.winRate === null ? 1 : (faded ? 0.4 : 1),
                                  outline: c.isDiagonal ? '1.5px solid rgba(249,158,26,0.6)' : undefined,
                                }}>
                                <div className="text-xs font-display leading-tight">{fmtRate(c.winRate)}</div>
                                {c.games > 0 && <div className="text-[9px] opacity-70 leading-tight">{c.games}g</div>}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-ow-faint">Pick at least one hero above to build the grid.</p>
              )}
            </div>

            {/* Top combinations table */}
            <div className="bg-ow-panel rounded-xl border border-ow-line p-4">
              <h3 className="font-display tracking-[0.12em] text-ow-fg uppercase text-sm mb-3">
                Your combinations {minSize === 1 ? '(incl. solo)' : minSize === 2 ? '(pairs+)' : '(trios+)'}
              </h3>
              {rankedCombos.length === 0 ? (
                <p className="text-sm text-ow-faint">No combinations at this size and threshold yet.</p>
              ) : (
                <div className="space-y-1.5">
                  <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 text-[10px] font-display tracking-wider
                    text-ow-faint uppercase px-2">
                    <span>Combination</span><span>Win rate</span><span>Games</span><span>Lift vs solo</span>
                  </div>
                  {rankedCombos.slice(0, 40).map(c => (
                    <button
                      key={c.key}
                      onClick={() => setBase(c.heroes)}
                      className={`w-full grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center text-left
                        bg-ow-dark rounded-lg px-2.5 py-2 border transition-colors
                        ${base.join() === c.heroes.join() ? 'border-ow-orange/60' : 'border-ow-line hover:border-ow-orange/40'}
                        ${c.lowConfidence ? 'opacity-50' : ''}`}>
                      <span className="font-display text-sm text-ow-fg truncate">{c.heroes.join(' + ')}</span>
                      <span className="text-sm font-display" style={{ color: rateColor(c.winRate) }}>{fmtRate(c.winRate)}</span>
                      <span className="text-xs text-ow-muted font-display">{c.games}</span>
                      <span className="text-xs font-display"
                        style={{ color: c.lift == null ? OW.draw : c.lift > 0 ? OW.victory : c.lift < 0 ? OW.defeat : OW.draw }}>
                        {fmtDelta(c.lift)}
                      </span>
                    </button>
                  ))}
                  <p className="text-[11px] text-ow-faint mt-2">
                    Tap a combination to see what adding another hero does to it. Lift compares the combo&apos;s win rate
                    to the average of its heroes&apos; solo win rates.
                  </p>
                </div>
              )}
            </div>

            {/* Lift drill-down */}
            {liftResult && base.length > 0 && (
              <div className="bg-ow-panel rounded-xl border border-ow-line p-4">
                <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
                  <h3 className="font-display tracking-[0.12em] text-ow-fg uppercase text-sm">
                    Adding a hero to {base.join(' + ')}
                  </h3>
                  <button onClick={() => setBase([])}
                    className="text-[11px] font-display tracking-wider text-ow-muted hover:text-ow-orange uppercase">
                    Clear
                  </button>
                </div>
                <p className="text-sm text-ow-muted mb-3">
                  Base: <span className="text-ow-fg">{base.join(' + ')}</span> —{' '}
                  {fmtRate(liftResult.baseStat?.winRate ?? null)} over {liftResult.baseStat?.games ?? 0} game
                  {(liftResult.baseStat?.games ?? 0) === 1 ? '' : 's'}.
                </p>
                {liftResult.rows.length === 0 ? (
                  <p className="text-sm text-ow-faint">No other heroes appeared alongside this combination.</p>
                ) : (
                  <div className="space-y-1.5">
                    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 text-[10px] font-display tracking-wider
                      text-ow-faint uppercase px-2">
                      <span>+ Hero</span><span>Combined</span><span>Games</span><span>Δ vs base</span>
                    </div>
                    {liftResult.rows.map(r => (
                      <div key={r.hero}
                        className={`grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center
                          bg-ow-dark rounded-lg px-2.5 py-2 border border-ow-line ${r.lowConfidence ? 'opacity-50' : ''}`}>
                        <span className="font-display text-sm text-ow-fg truncate">+ {r.hero}</span>
                        <span className="text-sm font-display" style={{ color: rateColor(r.combinedWinRate) }}>
                          {fmtRate(r.combinedWinRate)}
                        </span>
                        <span className="text-xs text-ow-muted font-display">{r.games}</span>
                        <span className="text-xs font-display"
                          style={{ color: r.delta == null ? OW.draw : r.delta > 0 ? OW.victory : r.delta < 0 ? OW.defeat : OW.draw }}>
                          {fmtDelta(r.delta)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
