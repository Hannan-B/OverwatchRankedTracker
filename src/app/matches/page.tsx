'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import { HEROES } from '@/data/reference'

// ============================================================
// MATCH HISTORY (Phase 2 — v3)
// - Dropdown filters: Season / Role / Hero (adaptive)
//   • Role = Tank/DPS/Support → Hero dropdown shows THAT role's heroes directly
//     (no extra role step)
//   • Role = 6v6 or All → an extra "Role" dropdown appears first, then Hero
// - Heroes bucketed by their REAL role from reference.ts (HERO_ROLE map),
//   NEVER by the match's role_played (that was the old broken logic)
// - Legible rows: LEFT role · map · mode · score | RIGHT relative time
// - No E/A/D or stars on the row; higher-contrast text
// - 20/page + Show more; scroll/state preserved across navigation
// ============================================================

type RoleFilter = 'all' | 'tank' | 'dps' | 'support' | '6v6'
type HeroRole = '' | 'tank' | 'dps' | 'support'
const PAGE = 20
const STATE_KEY = 'matchHistory:listState'

// Real hero → role, from reference data. Source of truth for bucketing heroes.
const HERO_ROLE = new Map<string, 'tank' | 'dps' | 'support'>(
  HEROES.map(h => [h.name, h.role])
)

interface Row {
  id: number
  played_at: string | null
  map: string | null
  game_mode: string | null
  result: 'victory' | 'defeat' | 'draw'
  score: string | null
  role_played: 'tank' | 'dps' | 'support'
  match_format: '5v5' | '6v6'
  season_id: number | null
  heroes_played: string[] | null
}
interface SeasonRow { id: number; name: string; start_date: string; end_date: string }

// relative time: "Xh ago" within 24h, else "Xd ago"
function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (isNaN(then)) return '—'
  const diffMs = Date.now() - then
  const hours = Math.floor(diffMs / 3_600_000)
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const ROLE_LABEL: Record<string, string> = { tank: 'TANK', dps: 'DPS', support: 'SUPPORT' }
const resultBar: Record<string, string> = {
  victory: 'border-l-ow-victory', defeat: 'border-l-ow-defeat', draw: 'border-l-ow-draw',
}
const resultText: Record<string, string> = {
  victory: 'text-ow-victory', defeat: 'text-ow-defeat', draw: 'text-ow-draw',
}

const selectCls =
  'bg-ow-dark border border-white/20 rounded-lg px-3 py-2 text-sm text-slate-100 ' +
  'font-display tracking-wider focus:border-ow-orange focus:outline-none transition-colors ' +
  '[color-scheme:dark]'

export default function MatchHistoryPage() {
  const router = useRouter()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [shown, setShown] = useState(PAGE)
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all')
  const [heroRole, setHeroRole] = useState<HeroRole>('')
  const [heroFilter, setHeroFilter] = useState<string>('')
  const [seasons, setSeasons] = useState<SeasonRow[]>([])
  const [currentSeasonId, setCurrentSeasonId] = useState<number | null>(null)
  const [scope, setScope] = useState<'current' | 'all' | number>('current')
  const restored = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    const today = new Date().toISOString().slice(0, 10)

    const { data: seasonData } = await supabase
      .from('seasons').select('id, name, start_date, end_date')
      .order('start_date', { ascending: false })
    const seasonsList = (seasonData as SeasonRow[] | null) || []
    setSeasons(seasonsList)
    const current = seasonsList.find(s => s.start_date <= today && today <= s.end_date)
    setCurrentSeasonId(current?.id ?? null)

    const [{ data: matchData }, { data: overviewData }] = await Promise.all([
      supabase.from('matches')
        .select('id, played_at, map, game_mode, result, score, role_played, match_format, season_id')
        .order('played_at', { ascending: false }),
      supabase.from('match_overview').select('id, heroes_played'),
    ])
    const heroesById = new Map<number, string[]>()
    ;(overviewData as { id: number; heroes_played: string[] | null }[] | null)
      ?.forEach(o => heroesById.set(o.id, o.heroes_played || []))
    const merged: Row[] = ((matchData as Omit<Row, 'heroes_played'>[]) || [])
      .map(m => ({ ...m, heroes_played: heroesById.get(m.id) || [] }))
    setRows(merged)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (loading || restored.current) return
    restored.current = true
    try {
      const raw = sessionStorage.getItem(STATE_KEY)
      if (raw) {
        const st = JSON.parse(raw)
        if (typeof st.shown === 'number') setShown(st.shown)
        if (st.roleFilter) setRoleFilter(st.roleFilter)
        if (st.heroRole !== undefined) setHeroRole(st.heroRole)
        if (st.heroFilter !== undefined) setHeroFilter(st.heroFilter)
        if (st.scope !== undefined) setScope(st.scope)
        requestAnimationFrame(() => window.scrollTo(0, st.scrollY || 0))
      }
    } catch { /* ignore */ }
  }, [loading])

  function openMatch(id: number) {
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify({
        shown, roleFilter, heroRole, heroFilter, scope, scrollY: window.scrollY,
      }))
    } catch { /* ignore */ }
    router.push(`/matches/${id}`)
  }

  const seasonScopedId = scope === 'current' ? currentSeasonId : scope === 'all' ? null : scope
  const seasonScoped = scope === 'all'
    ? rows
    : seasonScopedId == null
      ? (scope === 'current' ? [] : rows)
      : rows.filter(r => r.season_id === seasonScopedId)

  const roleFiltered = seasonScoped.filter(r => {
    if (roleFilter === 'all') return true
    if (roleFilter === '6v6') return r.match_format === '6v6'
    return r.match_format === '5v5' && r.role_played === roleFilter
  })

  // Adaptive hero-role: when Role is a specific 5v5 role, the effective hero-role
  // IS that role (no extra dropdown). When Role is All or 6v6, use the separate
  // hero-role dropdown selection.
  const showHeroRoleDropdown = roleFilter === 'all' || roleFilter === '6v6'
  const effectiveHeroRole: HeroRole = showHeroRoleDropdown ? heroRole : roleFilter

  // Hero options: every hero that appears in the role-filtered matches, bucketed by
  // the hero's REAL role (HERO_ROLE), then narrowed to the effective hero-role.
  const heroOptions = Array.from(new Set(
    roleFiltered
      .flatMap(r => r.heroes_played || [])
      .filter(h => !effectiveHeroRole || HERO_ROLE.get(h) === effectiveHeroRole)
  )).sort()

  const filtered = heroFilter
    ? roleFiltered.filter(r => (r.heroes_played || []).includes(heroFilter))
    : roleFiltered

  const visible = filtered.slice(0, shown)
  const canShowMore = shown < filtered.length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl tracking-[0.12em] text-slate-100 uppercase">Match History</h1>
        <p className="text-sm text-slate-400 mt-1">{filtered.length} matches</p>
      </div>

      {/* Filter dropdowns */}
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-400 font-display tracking-wider uppercase">Season</span>
          <select className={selectCls} value={String(scope)}
            onChange={e => {
              const v = e.target.value
              setScope(v === 'current' || v === 'all' ? v : Number(v))
              setShown(PAGE)
            }}>
            {currentSeasonId && <option value="current">Current</option>}
            {seasons.filter(s => s.id !== currentSeasonId).map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
            <option value="all">All Time</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-400 font-display tracking-wider uppercase">Role</span>
          <select className={selectCls} value={roleFilter}
            onChange={e => {
              setRoleFilter(e.target.value as RoleFilter)
              setHeroRole(''); setHeroFilter(''); setShown(PAGE)
            }}>
            <option value="all">All Roles</option>
            <option value="tank">Tank</option>
            <option value="dps">DPS</option>
            <option value="support">Support</option>
            <option value="6v6">6v6</option>
          </select>
        </label>

        {/* Extra hero-role dropdown ONLY when Role = All or 6v6.
            For a specific 5v5 role, the hero list is already that role. */}
        {showHeroRoleDropdown && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400 font-display tracking-wider uppercase">Role</span>
            <select className={selectCls} value={heroRole}
              onChange={e => { setHeroRole(e.target.value as HeroRole); setHeroFilter(''); setShown(PAGE) }}>
              <option value="">Any role</option>
              <option value="tank">Tank</option>
              <option value="dps">DPS</option>
              <option value="support">Support</option>
            </select>
          </label>
        )}

        {/* Hero dropdown shows whenever we have an effective hero-role to scope by. */}
        {effectiveHeroRole && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400 font-display tracking-wider uppercase">Hero</span>
            <select className={selectCls} value={heroFilter}
              onChange={e => { setHeroFilter(e.target.value); setShown(PAGE) }}>
              <option value="">Any {ROLE_LABEL[effectiveHeroRole]?.toLowerCase()} hero</option>
              {heroOptions.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>
        )}
      </div>

      {loading ? (
        <div className="text-center py-12 text-slate-300 font-display tracking-wider">LOADING…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-300">
          <p className="font-display text-lg tracking-wider">No matches</p>
          <p className="text-sm mt-1 text-slate-400">
            {rows.length === 0
              ? 'Upload your first match to see it here.'
              : scope === 'current' && !currentSeasonId
                ? 'No current season set. Add one in Settings → Seasons, or pick All Time.'
                : 'No matches fit these filters.'}
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-2.5">
            {visible.map(m => (
              <button key={m.id} onClick={() => openMatch(m.id)}
                className={`w-full text-left bg-ow-panel rounded-lg pl-4 pr-4 py-3.5 border-l-4 ${resultBar[m.result]}
                  border border-white/10 hover:border-ow-orange/40 transition-colors`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0 flex-wrap">
                    <span className="text-xs font-display font-bold tracking-wider text-ow-orange shrink-0">
                      {m.match_format === '6v6' ? '6V6' : ROLE_LABEL[m.role_played]}
                    </span>
                    <span className="font-display text-base font-bold text-white truncate">{m.map}</span>
                    {m.game_mode && (
                      <span className="text-[11px] text-slate-200 bg-white/10 px-2 py-0.5 rounded font-display tracking-wide uppercase shrink-0">
                        {m.game_mode}
                      </span>
                    )}
                    {m.score && (
                      <span className={`text-sm font-display font-bold ${resultText[m.result]} shrink-0`}>
                        {m.score}
                      </span>
                    )}
                  </div>
                  <span className="text-sm text-slate-300 font-display shrink-0">
                    {relativeTime(m.played_at)}
                  </span>
                </div>
              </button>
            ))}
          </div>

          {canShowMore && (
            <button onClick={() => setShown(s => s + PAGE)}
              className="w-full bg-ow-panel border border-white/15 hover:border-ow-orange/40 text-slate-200
                font-display font-bold py-3 rounded-lg tracking-wider transition-colors text-sm">
              SHOW MORE ({filtered.length - shown} more)
            </button>
          )}
        </>
      )}
    </div>
  )
}
