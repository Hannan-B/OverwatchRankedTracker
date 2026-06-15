'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import Select from '@/components/Select'
import { useRouter } from 'next/navigation'
import { HEROES } from '@/data/reference'
import { matchQuery } from '@/lib/alpha'

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

// ---- Readable match IDs (#13f) ----
// Label format: s{season}_{n}  e.g. "s2_12" = the 12th game (chronologically) of
// season 2. Derived at DISPLAY time from data we already have, so the scheme can
// change later (e.g. to year_season_match) by editing only this code — nothing
// is stored. Season number is parsed from the season NAME ("Season 2" -> 2);
// when a name has no number, it falls back to the season's chronological order
// (oldest start_date = 1). Matches with no season fall back to "#<id>".
//
// `buildMatchLabels` returns a map of match id -> label, computed once over all
// rows: for each season, its matches are sorted by played_at ascending and
// numbered 1..N (oldest first), so the newest game shows the highest number even
// though the list itself renders newest-first.

/** Parse a season number from its name, e.g. "Season 2" / "2026 S2" -> 2. */
function seasonNumberFromName(name: string): number | null {
  // Prefer a number right after an "s" or "season" token; else the last number.
  const tagged = name.match(/s(?:eason)?\s*0*(\d+)/i)
  if (tagged) return Number(tagged[1])
  const any = name.match(/(\d+)(?!.*\d)/)
  return any ? Number(any[1]) : null
}

/** id -> "s{season}_{n}" label, for every row that has a season. */
function buildMatchLabels(rows: Row[], seasons: SeasonRow[]): Map<number, string> {
  // Season number per season id: parsed name, else chronological order (oldest=1).
  const byStart = [...seasons].sort((a, b) => a.start_date.localeCompare(b.start_date))
  const seasonNum = new Map<number, number>()
  byStart.forEach((s, i) => {
    seasonNum.set(s.id, seasonNumberFromName(s.name) ?? (i + 1))
  })

  // Group rows by season, order each group oldest-first, assign 1..N.
  const bySeason = new Map<number, Row[]>()
  for (const r of rows) {
    if (r.season_id == null) continue
    const group = bySeason.get(r.season_id)
    if (group) group.push(r)
    else bySeason.set(r.season_id, [r])
  }
  const labels = new Map<number, string>()
  for (const [sid, group] of bySeason) {
    const sNum = seasonNum.get(sid)
    if (sNum == null) continue
    group
      .sort((a, b) => (a.played_at ?? '').localeCompare(b.played_at ?? ''))
      .forEach((r, i) => labels.set(r.id, `s${sNum}_${i + 1}`))
  }
  return labels
}

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
  'bg-ow-dark border border-ow-line rounded-lg px-3 py-2 text-sm text-ow-fg ' +
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

  // ── Delete saved matches (permanent) ──
  // selectMode toggles checkboxes + the bulk bar; selectedIds holds chosen match
  // ids; confirmingDelete opens the typed-confirmation modal; confirmText is what
  // the user types ("DELETE") to arm the button; deleting disables it mid-flight.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
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
      matchQuery('id, played_at, map, game_mode, result, score, role_played, match_format, season_id')
        .order('played_at', { ascending: false }),
      supabase.from('match_overview').select('id, heroes_played'),
    ])
    const heroesById = new Map<number, string[]>()
    ;(overviewData as { id: number; heroes_played: string[] | null }[] | null)
      ?.forEach(o => heroesById.set(o.id, o.heroes_played || []))
    const merged: Row[] = ((matchData as unknown as Omit<Row, 'heroes_played'>[]) || [])
      .map(m => ({ ...m, heroes_played: heroesById.get(m.id) || [] }))
    setRows(merged)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Escape closes the delete-confirm modal (unless a delete is mid-flight).
  useEffect(() => {
    if (!confirmingDelete) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !deleting) { setConfirmingDelete(false); setConfirmText('') }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirmingDelete, deleting])

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

  // ── Selection + permanent delete ──
  function toggleSelected(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function exitSelectMode() {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  // Hard-delete the selected matches. Because every child FK is ON DELETE CASCADE
  // (hero_performances, scoreboard_players, hero_stats, match_images), deleting the
  // `matches` rows removes all their data — and the analytics views recompute live,
  // so the matches stop counting immediately. Targeted by explicit id, so an active
  // filter can never cause the wrong row to be deleted.
  async function deleteSelectedMatches() {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setDeleting(true)
    try {
      const { error } = await supabase.from('matches').delete().in('id', ids)
      if (error) {
        console.error('Failed to delete matches:', error)
        setDeleting(false)
        return // keep the modal open so the user sees it didn't complete
      }
      // Drop the deleted rows from the list locally (no full reload needed).
      const deleted = new Set(ids)
      setRows(prev => prev.filter(r => !deleted.has(r.id)))
      setSelectedIds(new Set())
      setSelectMode(false)
      setConfirmingDelete(false)
      setConfirmText('')
    } catch (err) {
      console.error('Failed to delete matches:', err)
    } finally {
      setDeleting(false)
    }
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

  // Readable id labels (#13f), computed over ALL rows so a match's number is its
  // stable chronological position within its season (not its position in the
  // current filter). Recomputed only when rows/seasons change.
  const matchLabels = useMemo(() => buildMatchLabels(rows, seasons), [rows, seasons])

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-3xl tracking-[0.12em] text-ow-fg uppercase">Match History</h1>
          <p className="text-sm text-ow-muted mt-1">{filtered.length} matches</p>
        </div>
        {rows.length > 0 && (
          <button
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            className="text-xs font-display tracking-wider px-3 py-1.5 rounded-lg border border-ow-line text-ow-muted hover:border-ow-orange/40 transition-colors shrink-0">
            {selectMode ? 'CANCEL' : 'SELECT'}
          </button>
        )}
      </div>

      {/* Bulk-delete bar — only in select mode */}
      {selectMode && (
        <div className="flex items-center justify-between gap-3 flex-wrap bg-ow-panel border border-ow-line rounded-lg px-4 py-3">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => {
                const visibleIds = visible.map(m => m.id)
                const allSelected = visibleIds.every(id => selectedIds.has(id))
                setSelectedIds(allSelected ? new Set() : new Set(visibleIds))
              }}
              className="text-xs text-ow-faint hover:text-ow-muted font-display tracking-wider transition-colors">
              {visible.length > 0 && visible.every(m => selectedIds.has(m.id)) ? '✓ DESELECT ALL' : '☐ SELECT ALL'}
            </button>
            <span className="text-xs text-ow-muted font-display">
              {selectedIds.size} selected
            </span>
          </div>
          <button
            onClick={() => { setConfirmText(''); setConfirmingDelete(true) }}
            disabled={selectedIds.size === 0}
            className="bg-ow-defeat/90 hover:bg-ow-defeat text-white font-display font-bold px-4 py-2 rounded-lg tracking-wider text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            DELETE {selectedIds.size > 0 ? `${selectedIds.size} ` : ''}SELECTED
          </button>
        </div>
      )}

      {/* Filter dropdowns */}
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-ow-muted font-display tracking-wider uppercase">Season</span>
          <Select<string>
            className={selectCls}
            value={String(scope)}
            onChange={v => {
              setScope(v === 'current' || v === 'all' ? v : Number(v))
              setShown(PAGE)
            }}
            options={[
              ...(currentSeasonId ? [{ value: 'current', label: 'Current' }] : []),
              ...seasons.filter(s => s.id !== currentSeasonId).map(s => ({ value: String(s.id), label: s.name })),
              { value: 'all', label: 'All Time' },
            ]}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-ow-muted font-display tracking-wider uppercase">Role</span>
          <Select<RoleFilter>
            className={selectCls}
            value={roleFilter}
            onChange={v => {
              setRoleFilter(v)
              setHeroRole(''); setHeroFilter(''); setShown(PAGE)
            }}
            options={[
              { value: 'all', label: 'All Roles' },
              { value: 'tank', label: 'Tank' },
              { value: 'dps', label: 'DPS' },
              { value: 'support', label: 'Support' },
              { value: '6v6', label: '6v6' },
            ]}
          />
        </label>

        {/* Extra hero-role dropdown ONLY when Role = All or 6v6.
            For a specific 5v5 role, the hero list is already that role. */}
        {showHeroRoleDropdown && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-ow-muted font-display tracking-wider uppercase">Role</span>
            <Select<HeroRole>
              className={selectCls}
              value={heroRole}
              onChange={v => { setHeroRole(v); setHeroFilter(''); setShown(PAGE) }}
              options={[
                { value: '', label: 'Any role' },
                { value: 'tank', label: 'Tank' },
                { value: 'dps', label: 'DPS' },
                { value: 'support', label: 'Support' },
              ]}
            />
          </label>
        )}

        {/* Hero dropdown shows whenever we have an effective hero-role to scope by. */}
        {effectiveHeroRole && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-ow-muted font-display tracking-wider uppercase">Hero</span>
            <Select<string>
              className={selectCls}
              value={heroFilter}
              onChange={v => { setHeroFilter(v); setShown(PAGE) }}
              options={[
                { value: '', label: `Any ${ROLE_LABEL[effectiveHeroRole]?.toLowerCase()} hero` },
                ...heroOptions.map(h => ({ value: h, label: h })),
              ]}
            />
          </label>
        )}
      </div>

      {loading ? (
        <div className="text-center py-12 text-ow-muted font-display tracking-wider">LOADING…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-ow-muted">
          <p className="font-display text-lg tracking-wider">No matches</p>
          <p className="text-sm mt-1 text-ow-muted">
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
            {visible.map(m => {
              const isSel = selectedIds.has(m.id)
              return (
              <div key={m.id}
                className={`flex items-stretch bg-ow-panel rounded-lg border-l-4 ${resultBar[m.result]}
                  border ${isSel ? 'border-ow-orange/50' : 'border-ow-line'} hover:border-ow-orange/40 transition-colors overflow-hidden`}>
                {/* Checkbox (select mode only) */}
                {selectMode && (
                  <button
                    onClick={() => toggleSelected(m.id)}
                    aria-label={isSel ? 'Deselect match' : 'Select match'}
                    className="flex items-center pl-3 pr-1 shrink-0">
                    <span className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                      isSel ? 'border-ow-orange bg-ow-orange text-ow-dark' : 'border-slate-600'
                    }`}>
                      {isSel && <span className="text-xs font-bold">✓</span>}
                    </span>
                  </button>
                )}

                {/* Clickable match content — opens the match (or toggles in select mode) */}
                <button
                  onClick={() => (selectMode ? toggleSelected(m.id) : openMatch(m.id))}
                  className="flex-1 min-w-0 text-left pl-4 pr-3 py-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0 flex-wrap">
                      <span className="text-xs font-display font-bold tracking-wider text-ow-orange shrink-0">
                        {m.match_format === '6v6' ? '6V6' : ROLE_LABEL[m.role_played]}
                      </span>
                      <span className="font-display text-base font-bold text-ow-fg truncate">{m.map}</span>
                      {m.game_mode && (
                        <span className="text-[11px] text-ow-fg bg-white/10 px-2 py-0.5 rounded font-display tracking-wide uppercase shrink-0">
                          {m.game_mode}
                        </span>
                      )}
                      {m.score && (
                        <span className={`text-sm font-display font-bold ${resultText[m.result]} shrink-0`}>
                          {m.score}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col items-end shrink-0">
                      {matchLabels.has(m.id) && (
                        <span className="text-[10px] text-ow-faint font-mono tracking-wider tabular-nums">
                          {matchLabels.get(m.id)}
                        </span>
                      )}
                      <span className="text-sm text-ow-muted font-display">
                        {relativeTime(m.played_at)}
                      </span>
                    </div>
                  </div>
                </button>

                {/* Trash icon — selects this one match and opens the confirm modal */}
                <button
                  onClick={() => { setSelectMode(true); setSelectedIds(new Set([m.id])); setConfirmText(''); setConfirmingDelete(true) }}
                  aria-label="Delete this match"
                  title="Delete this match"
                  className="flex items-center px-3 shrink-0 text-ow-faint hover:text-ow-defeat transition-colors">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    <line x1="10" y1="11" x2="10" y2="17" />
                    <line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
                </button>
              </div>
              )
            })}
          </div>

          {canShowMore && (
            <button onClick={() => setShown(s => s + PAGE)}
              className="w-full bg-ow-panel border border-ow-line hover:border-ow-orange/40 text-ow-fg
                font-display font-bold py-3 rounded-lg tracking-wider transition-colors text-sm">
              SHOW MORE ({filtered.length - shown} more)
            </button>
          )}
        </>
      )}

      {/* Permanent-delete confirmation — requires typing DELETE to arm the button */}
      {confirmingDelete && (
        <div
          onClick={() => { if (!deleting) { setConfirmingDelete(false); setConfirmText('') } }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true">
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-ow-panel border border-ow-defeat/40 rounded-xl p-6 max-w-md w-full space-y-4 shadow-xl">
            <div className="space-y-1">
              <h2 className="text-ow-defeat font-display font-bold tracking-wider">
                Delete {selectedIds.size} match{selectedIds.size !== 1 ? 'es' : ''}?
              </h2>
              <p className="text-sm text-ow-muted">
                This permanently removes {selectedIds.size === 1 ? 'this match' : 'these matches'} and
                all associated data — hero performances, scoreboard, and breakdown stats — from your
                database. The deleted {selectedIds.size === 1 ? 'match' : 'matches'} will no longer
                count in any analytics. <span className="text-ow-fg font-bold">This cannot be undone.</span>
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-ow-faint font-display tracking-wider uppercase">
                Type <span className="text-ow-defeat font-bold">DELETE</span> to confirm
              </label>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoFocus
                placeholder="DELETE"
                className="w-full bg-ow-dark border border-ow-line rounded-lg px-3 py-2 text-sm text-ow-fg placeholder-ow-faint focus:outline-none focus:border-ow-defeat/50"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setConfirmingDelete(false); setConfirmText('') }}
                disabled={deleting}
                className="bg-ow-dark border border-ow-line text-ow-muted font-display tracking-wider text-xs px-4 py-2 rounded-lg hover:border-ow-orange/30 transition-colors disabled:opacity-50">
                CANCEL
              </button>
              <button
                onClick={deleteSelectedMatches}
                disabled={deleting || confirmText.trim().toUpperCase() !== 'DELETE'}
                className="bg-ow-defeat/90 hover:bg-ow-defeat text-white font-display font-bold tracking-wider text-xs px-4 py-2 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                {deleting ? 'DELETING…' : `DELETE ${selectedIds.size}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
