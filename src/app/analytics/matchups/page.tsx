'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import Select from '@/components/Select'
import { keepVisible } from '@/lib/alpha'
import { heroPortrait } from '@/lib/hero-image'
import AnalyticsFilters, {
  DEFAULT_FILTERS,
  type AnalyticsFilterState,
} from '@/components/AnalyticsFilters'
import { AnalyticsNav, AnalyticsHeader } from '@/components/AnalyticsNav'
import { HEROES, getHeroesByRole } from '@/data/reference'
import {
  aggregateSingles,
  rankTopNPerRole,
  aggregateCombo,
  aggregateBoth,
  pairingMatrixSameRelation,
  pairingMatrixCross,
  computeLift,
  computeLiftBoth,
  conformance222,
  queueFixedRole,
  otherSlotShape,
  CONFIDENCE_MIN_GAMES,
  type PairRow,
  type TeamSetRow,
  type MatchupFilters,
  type Cell,
  type Relation,
  type Role,
  type Direction,
  type ComboMode,
  type SlotShape,
  type PairingMatrix,
  type MatrixCell,
  type LiftView,
  type LiftViewBoth,
  type AttributionMode,
} from './matchups-lib'

// ============================================================
// /analytics/matchups — hero-anchored matchups & pairings (SURFACE 2)
// ------------------------------------------------------------
// By Hero / General · four ranked lists (top-5 per role, 2dp win rate +
// record, <5 games dimmed) · scoreboard-style Combination Lab with
// Ally / Enemy / Both layouts. Heavy math in the matchup_* SQL views;
// this page filters + games-weights in JS. Alpha rows gated by
// keepVisible() (prod excludes null-season; localhost can opt in).
// ============================================================

const ROLES: Role[] = ['tank', 'dps', 'support']
const ROLE_LABEL: Record<Role, string> = { tank: 'Tank', dps: 'DPS', support: 'Support' }

type Format = '5v5' | '6v6'

function toMatchupFilters(
  f: AnalyticsFilterState,
  attribution: AttributionMode,
  pctThreshold: number,
  secThreshold: number,
): MatchupFilters {
  return {
    queue: (f.queue || 'all') as MatchupFilters['queue'],
    mode: (f.mode || 'all') as MatchupFilters['mode'],
    map: (f.map || 'all') as MatchupFilters['map'],
    attribution,
    pctThreshold,
    secThreshold,
  }
}

export default function MatchupsPage() {
  const [filters, setFilters] = useState<AnalyticsFilterState>(DEFAULT_FILTERS)

  // surface controls
  const [anchorMode, setAnchorMode] = useState<'hero' | 'general'>('hero')
  const [anchorHero, setAnchorHero] = useState<string>('')
  const [winFloor, setWinFloor] = useState<number | null>(null)
  const [attribution, setAttribution] = useState<AttributionMode>('all')
  // Adjustable threshold VALUES for the attribution toggle (step 9). The toggle
  // still picks the mode; these set the numbers it applies. Defaults match the
  // old fixed behaviour (95% / 60s), reactive + per-visit.
  const [pctThreshold, setPctThreshold] = useState<number>(95)
  const [secThreshold, setSecThreshold] = useState<number>(60)

  // combination lab controls
  const [labLayout, setLabLayout] = useState<'ally' | 'enemy' | 'both'>('ally')
  const [allyMode, setAllyMode] = useState<ComboMode>('cooccurrence')
  const [enemyMode, setEnemyMode] = useState<ComboMode>('cooccurrence')
  const [allyPick, setAllyPick] = useState<Record<Role, string[]>>({ tank: [], dps: [], support: [] })
  const [enemyPick, setEnemyPick] = useState<Record<Role, string[]>>({ tank: [], dps: [], support: [] })
  // 6v6 role-shape choosers — independent per team, and per feature.
  const [labSixAlly, setLabSixAlly] = useState<SlotShape>({ tank: 2, dps: 2, support: 2 })
  const [labSixEnemy, setLabSixEnemy] = useState<SlotShape>({ tank: 2, dps: 2, support: 2 })

  // lift drill-down: mode (ally / enemy / both) + per-side sets
  const [liftMode, setLiftMode] = useState<'ally' | 'enemy' | 'both'>('ally')
  const [liftAllySet, setLiftAllySet] = useState<string[]>([])
  const [liftEnemySet, setLiftEnemySet] = useState<string[]>([])
  const [liftSixAlly, setLiftSixAlly] = useState<SlotShape>({ tank: 2, dps: 2, support: 2 })
  const [liftSixEnemy, setLiftSixEnemy] = useState<SlotShape>({ tank: 2, dps: 2, support: 2 })

  // data
  const [pairs, setPairs] = useState<PairRow[]>([])
  const [teamSets, setTeamSets] = useState<TeamSetRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const [pairRes, setRes] = await Promise.all([
          supabase.from('matchup_pairs').select('*'),
          supabase.from('matchup_team_sets').select('*'),
        ])
        if (pairRes.error) throw pairRes.error
        if (setRes.error) throw setRes.error
        if (cancelled) return
        setPairs(keepVisible(pairRes.data ?? []) as PairRow[])
        setTeamSets(keepVisible(setRes.data ?? []) as TeamSetRow[])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load matchup data')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [])

  const mf = useMemo(() => toMatchupFilters(filters, attribution, pctThreshold, secThreshold), [filters, attribution, pctThreshold, secThreshold])
  const fixedRole = queueFixedRole(mf.queue)             // role pinned by Queue, or null
  const labFormat: Format = mf.queue === '6v6' ? '6v6' : '5v5'
  const activeAnchor = anchorMode === 'hero' ? (anchorHero || null) : null

  // --- queue-role scoping: auto-clear an anchor hero that conflicts ---
  useEffect(() => {
    if (!anchorHero) return
    const h = HEROES.find((x) => x.name === anchorHero)
    if (fixedRole && h && h.role !== fixedRole) setAnchorHero('')
  }, [fixedRole, anchorHero])

  // heroes the user actually played, optionally scoped to the Queue role
  const playedHeroes = useMemo(() => {
    const s = new Set(pairs.map((p) => p.anchor_hero))
    return new Set(HEROES.filter((h) => s.has(h.name)).map((h) => h.name))
  }, [pairs])

  const anchorRolesToShow: Role[] = fixedRole ? [fixedRole] : ROLES

  // --- the four ranked lists ---
  function lists(relation: Relation, direction: Direction): Record<Role, Cell[]> {
    const cells = aggregateSingles(pairs, relation, mf, activeAnchor)
    return rankTopNPerRole(cells, direction, 5, winFloor != null ? { minWinRate: winFloor } : undefined)
  }
  const allyBest = useMemo(() => lists('ally', 'best'), [pairs, mf, activeAnchor, winFloor])
  const allyWorst = useMemo(() => lists('ally', 'worst'), [pairs, mf, activeAnchor, winFloor])
  const enemyBest = useMemo(() => lists('enemy', 'best'), [pairs, mf, activeAnchor, winFloor])
  const enemyWorst = useMemo(() => lists('enemy', 'worst'), [pairs, mf, activeAnchor, winFloor])

  const conf = useMemo(() => conformance222(teamSets), [teamSets])
  const needsHero = anchorMode === 'hero' && !activeAnchor

  // flatten role-keyed picks to arrays
  const allySel = useMemo(() => [...allyPick.tank, ...allyPick.dps, ...allyPick.support], [allyPick])
  const enemySel = useMemo(() => [...enemyPick.tank, ...enemyPick.dps, ...enemyPick.support], [enemyPick])

  // --- lab results ---
  const allyResult = useMemo(
    () => (allySel.length ? aggregateCombo(teamSets, 'ally', mf, activeAnchor, allySel, allyMode) : null),
    [teamSets, mf, activeAnchor, allySel, allyMode],
  )
  const enemyResult = useMemo(
    () => (enemySel.length ? aggregateCombo(teamSets, 'enemy', mf, activeAnchor, enemySel, enemyMode) : null),
    [teamSets, mf, activeAnchor, enemySel, enemyMode],
  )
  const bothResult = useMemo(
    () => ((allySel.length || enemySel.length)
      ? aggregateBoth(teamSets, mf, activeAnchor, allySel, enemySel, allyMode, enemyMode)
      : null),
    [teamSets, mf, activeAnchor, allySel, enemySel, allyMode, enemyMode],
  )

  // --- pairing matrix (grid), keyed to the active layout ---
  // The anchor hero (the one you played) is slotted into the ALLY axis
  // so the grid shows how you pair with each selected teammate. It's
  // placed in role order (tank → dps → support) alongside the picks.
  function withAnchorAllies(picks: string[]): string[] {
    if (!activeAnchor || picks.includes(activeAnchor)) return picks
    const all = [activeAnchor, ...picks]
    const order: Record<Role, number> = { tank: 0, dps: 1, support: 2 }
    return all.sort((a, b) => {
      const ra = HEROES.find((h) => h.name === a)?.role ?? 'dps'
      const rb = HEROES.find((h) => h.name === b)?.role ?? 'dps'
      return order[ra] - order[rb]
    })
  }
  const allyAxis = useMemo(() => withAnchorAllies(allySel), [allySel, activeAnchor])

  const matrix = useMemo<PairingMatrix | null>(() => {
    if (labLayout === 'ally') {
      return allyAxis.length ? pairingMatrixSameRelation(teamSets, 'ally', mf, activeAnchor, allyAxis) : null
    }
    if (labLayout === 'enemy') {
      return enemySel.length ? pairingMatrixSameRelation(teamSets, 'enemy', mf, activeAnchor, enemySel) : null
    }
    // both → ally rows (incl. you) × enemy cols
    return (allyAxis.length && enemySel.length)
      ? pairingMatrixCross(teamSets, mf, activeAnchor, allyAxis, enemySel)
      : null
  }, [labLayout, teamSets, mf, activeAnchor, allyAxis, enemySel])

  // user's slot for the scoreboard (fixed by Queue in 5v5, else the anchor's role)
  const userRole: Role | null = fixedRole
    ?? (activeAnchor ? (HEROES.find((h) => h.name === activeAnchor)?.role ?? null) : null)

  // --- lift drill-down ---
  const heroRole = (h: string): Role | null => HEROES.find((x) => x.name === h)?.role ?? null
  const allHeroList = useMemo(() => HEROES.map((h) => ({ name: h.name, role: h.role })), [])
  // team shape for each lift side: 6v6 uses that side's chooser; 5v5 is
  // locked 1-2-2. These are FULL team shapes (computeLift reserves the
  // user's role itself).
  const liftShape: SlotShape = labFormat === '6v6' ? liftSixAlly : { tank: 1, dps: 2, support: 2 }
  const enemyLiftShape: SlotShape = labFormat === '6v6' ? liftSixEnemy : { tank: 1, dps: 2, support: 2 }

  // single-side lift (ally OR enemy)
  const singleRelation: Relation = liftMode === 'enemy' ? 'enemy' : 'ally'
  const singleSet = liftMode === 'enemy' ? liftEnemySet : liftAllySet
  const singleUserRole = singleRelation === 'ally' ? userRole : null
  const singleShape = singleRelation === 'ally' ? liftShape : enemyLiftShape
  const lift = useMemo<LiftView>(
    () => computeLift(
      teamSets, singleRelation, mf, activeAnchor, singleSet,
      singleShape, singleUserRole, heroRole, allHeroList,
    ),
    [teamSets, singleRelation, mf, activeAnchor, singleSet, singleShape, singleUserRole, allHeroList],
  )

  // interleaved both-sides lift
  const liftBoth = useMemo<LiftViewBoth>(
    () => computeLiftBoth(
      teamSets, mf, activeAnchor, liftAllySet, liftEnemySet,
      liftShape, enemyLiftShape, userRole, heroRole, allHeroList,
    ),
    [teamSets, mf, activeAnchor, liftAllySet, liftEnemySet, liftShape, enemyLiftShape, userRole, allHeroList],
  )

  return (
    <div className="space-y-6">
      <AnalyticsHeader
        title="Hero Matchups"
        subtitle="Who you win with — and against. Pick a hero, or see the general picture."
      />
      <AnalyticsNav />

      <AnalyticsFilters
        value={filters}
        onChange={setFilters}
        show={{ queue: true, mode: true, map: true, hero: false }}
      />

      {/* surface controls */}
      <div className="bg-ow-panel rounded-lg p-4 border border-ow-line space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            value={anchorMode}
            onChange={(v) => setAnchorMode(v as 'hero' | 'general')}
            tone="green"
            options={[
              { value: 'hero', label: 'By Hero' },
              { value: 'general', label: 'General (all heroes)' },
            ]}
          />

          {anchorMode === 'hero' && (
            <div className="flex items-center gap-2">
              {anchorHero && (
                <img
                  src={heroPortrait(anchorHero)}
                  alt={anchorHero}
                  className="w-9 h-9 rounded object-cover bg-ow-bg border border-ow-line"
                />
              )}
              <Select<string>
                value={anchorHero}
                onChange={setAnchorHero}
                placeholder="Choose a hero…"
                className="text-sm"
                options={[
                  { value: '', label: 'Choose a hero…' },
                  ...anchorRolesToShow.flatMap((role) =>
                    getHeroesByRole(role).map((h) => ({
                      value: h.name,
                      label: `${ROLE_LABEL[role]} — ${h.name}${!playedHeroes.has(h.name) ? ' — no games' : ''}`,
                      disabled: !playedHeroes.has(h.name),
                    })),
                  ),
                ]}
              />
              {fixedRole && (
                <span className="text-xs text-ow-faint">
                  scoped to {ROLE_LABEL[fixedRole]} by the Queue filter
                </span>
              )}
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-ow-muted ml-auto">
            My hero counts as
            <Select<AttributionMode>
              value={attribution}
              onChange={setAttribution}
              className="text-sm"
              options={[
                { value: 'all', label: 'All games' },
                { value: 'min1', label: 'Played \u2265 time' },
                { value: 'pct95', label: 'Played \u2265 %' },
              ]}
            />
          </label>

          {/* Adjustable value for the chosen attribution mode (step 9). Appears
              only for the mode it applies to; 'all' shows nothing. The toggle
              picks the mode, this sets the number it enforces. */}
          {attribution === 'min1' && (
            <label className="flex items-center gap-2 text-sm text-ow-muted">
              Min time
              <Select<number>
                value={secThreshold}
                onChange={setSecThreshold}
                className="text-sm"
                options={[
                  { value: 60, label: '\u2265 60s' },
                  { value: 30, label: '\u2265 30s' },
                ]}
              />
            </label>
          )}
          {attribution === 'pct95' && (
            <label className="flex items-center gap-2 text-sm text-ow-muted">
              Min %
              <Select<number>
                value={pctThreshold}
                onChange={setPctThreshold}
                className="text-sm"
                options={[
                  { value: 95, label: '\u2265 95%' },
                  { value: 90, label: '\u2265 90%' },
                ]}
              />
            </label>
          )}

          <label className="flex items-center gap-2 text-sm text-ow-muted">
            Win-rate floor
            <Select<string>
              value={winFloor == null ? '' : String(winFloor)}
              onChange={v => setWinFloor(v === '' ? null : Number(v))}
              className="text-sm"
              options={[
                { value: '', label: 'Off' },
                { value: '50', label: '\u2265 50%' },
                { value: '55', label: '\u2265 55%' },
                { value: '60', label: '\u2265 60%' },
              ]}
            />
          </label>
        </div>

        <p className="text-xs text-ow-faint">
          Win rate excludes draws from the percentage (shown separately). Anything under{' '}
          {CONFIDENCE_MIN_GAMES} games is dimmed — a confidence boundary, not a cutoff. Roles
          come from the hero you played, not the scoreboard icon. The &ldquo;my hero counts as&rdquo;
          setting only affects which of <em>your</em> games count (teammate/enemy heroes are taken
          from the scoreboard as-is).
        </p>
      </div>

      {loading && <Panel><Muted>Loading matchup data…</Muted></Panel>}
      {error && <Panel><span className="text-red-300 text-sm">{error}</span></Panel>}

      {!loading && !error && (
        needsHero ? (
          <Panel><Muted>Pick one of your heroes above to see its matchups and pairings.</Muted></Panel>
        ) : (
          <>
            <SparsityNote pairs={pairs} anchor={activeAnchor} mf={mf} />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ListCard title="Best ALLY pairings" hint="Teammates you win most alongside" data={allyBest} relation="ally" />
              <ListCard title="Worst ALLY pairings" hint="Teammates you win least alongside" data={allyWorst} relation="ally" />
              <ListCard title="Best ENEMY matchups" hint="Opponents you beat most" data={enemyBest} relation="enemy" />
              <ListCard title="Worst ENEMY matchups" hint="Opponents you struggle against most" data={enemyWorst} relation="enemy" />
            </div>

            <ComboLab
              layout={labLayout}
              setLayout={setLabLayout}
              format={labFormat}
              userRole={userRole}
              labSixAlly={labSixAlly}
              setLabSixAlly={setLabSixAlly}
              labSixEnemy={labSixEnemy}
              setLabSixEnemy={setLabSixEnemy}
              liftSixAlly={liftSixAlly}
              setLiftSixAlly={setLiftSixAlly}
              liftSixEnemy={liftSixEnemy}
              setLiftSixEnemy={setLiftSixEnemy}
              allyPick={allyPick}
              setAllyPick={setAllyPick}
              enemyPick={enemyPick}
              setEnemyPick={setEnemyPick}
              allyMode={allyMode}
              setAllyMode={setAllyMode}
              enemyMode={enemyMode}
              setEnemyMode={setEnemyMode}
              allyResult={allyResult}
              enemyResult={enemyResult}
              bothResult={bothResult}
              matrix={matrix}
              anchorHero={activeAnchor}
              lift={lift}
              liftBoth={liftBoth}
              liftMode={liftMode}
              setLiftMode={setLiftMode}
              liftAllySet={liftAllySet}
              setLiftAllySet={setLiftAllySet}
              liftEnemySet={liftEnemySet}
              setLiftEnemySet={setLiftEnemySet}
            />

            {conf.total > 0 && (
              <p className="text-xs text-ow-faint">
                6v6 note: slots assume 2-2-2 (adjustable in the lab). Of your {conf.total} 6v6
                games, {conf.conforming} fit 2-2-2 and {conf.deviating} didn&apos;t — deviating
                games still appear, slotted by best effort.
              </p>
            )}
          </>
        )
      )}
    </div>
  )
}

// ====================================================================
// Presentational pieces
// ====================================================================

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="bg-ow-panel rounded-lg p-6 border border-ow-line">{children}</div>
}
function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-ow-muted text-center">{children}</p>
}

type Tone = 'green' | 'blue' | 'red'
const TONE_ACTIVE: Record<Tone, string> = {
  green: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  blue: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
  red: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
}

function Segmented({
  value, onChange, options, tone = 'green', toneByValue,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  tone?: Tone
  toneByValue?: Record<string, Tone>   // per-option active tone (ally=blue, enemy=red)
}) {
  return (
    <div className="inline-flex rounded-md border border-ow-line overflow-hidden">
      {options.map((o) => {
        const active = value === o.value
        const t = toneByValue?.[o.value] ?? tone
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={
              'px-3 py-1.5 text-sm transition-colors border-l first:border-l-0 border-ow-line ' +
              (active ? TONE_ACTIVE[t] : 'text-ow-muted hover:text-ow-fg hover:bg-white/5')
            }
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function WinRateBadge({ cell, big }: { cell: Cell; big?: boolean }) {
  const rate = cell.winRate
  const color =
    rate == null ? 'text-ow-faint'
      : rate >= 55 ? 'text-emerald-300'
        : rate <= 45 ? 'text-rose-300'
          : 'text-ow-fg'
  return (
    <span className={`font-display tabular-nums ${color} ${big ? 'text-2xl' : ''}`}>
      {rate == null ? '—' : rate.toFixed(2) + '%'}
    </span>
  )
}

function RecordLine({ cell }: { cell: Cell }) {
  return (
    <span className="text-xs text-ow-faint tabular-nums">
      {cell.wins}W–{cell.losses}L{cell.draws ? `–${cell.draws}D` : ''} · {cell.games} {cell.games === 1 ? 'game' : 'games'}
    </span>
  )
}

// Square hero box, Hero-Analytics style.
function HeroBox({ name, size = 56 }: { name: string; size?: number }) {
  return (
    <div
      className="relative rounded-md overflow-hidden bg-ow-bg border border-ow-line shrink-0"
      style={{ width: size, height: size }}
    >
      <img src={heroPortrait(name)} alt={name} className="w-full h-full object-cover" loading="lazy" />
    </div>
  )
}

function HeroRankRow({ cell }: { cell: Cell }) {
  return (
    <li
      className={
        'flex items-center gap-3 py-2 border-b border-ow-line last:border-0 ' +
        (cell.lowConfidence ? 'opacity-45' : '')
      }
      title={cell.lowConfidence ? `Low confidence — under ${CONFIDENCE_MIN_GAMES} games` : undefined}
    >
      <HeroBox name={cell.hero} size={44} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ow-fg truncate flex items-center gap-1.5">
          {cell.hero}
          {cell.anyRoleDisagreement && (
            <span title="Scoreboard role icon disagreed with hero role on at least one game" className="text-amber-400/70 text-xs">⚠</span>
          )}
        </div>
        <RecordLine cell={cell} />
      </div>
      <WinRateBadge cell={cell} />
    </li>
  )
}

function ListCard({
  title, hint, data, relation,
}: {
  title: string; hint: string; data: Record<Role, Cell[]>; relation: Relation
}) {
  const empty = ROLES.every((r) => data[r].length === 0)
  return (
    <div className="bg-ow-panel rounded-lg border border-ow-line overflow-hidden">
      <div className="px-4 py-3 border-b border-ow-line">
        <h3 className="font-display tracking-wider text-ow-fg text-sm uppercase">{title}</h3>
        <p className="text-xs text-ow-faint mt-0.5">{hint}</p>
      </div>
      <div className="p-4 space-y-4">
        {empty ? (
          <Muted>No {relation} data for this selection yet.</Muted>
        ) : (
          ROLES.map((role) =>
            data[role].length === 0 ? null : (
              <div key={role}>
                <div className="text-[11px] uppercase tracking-widest text-ow-faint mb-1">{ROLE_LABEL[role]}</div>
                <ul>{data[role].map((cell) => <HeroRankRow key={cell.hero} cell={cell} />)}</ul>
              </div>
            ),
          )
        )}
      </div>
    </div>
  )
}

// ====================================================================
// COMBINATION LAB — scoreboard-style picker
// ====================================================================

// One scoreboard for a team: role-grouped slots in tank→dps→support
// order, the user's own slot marked, others fillable from dropdowns.
function Scoreboard({
  teamLabel, accent, userRole, isUserTeam, shape, pick, setPick, excludeHeroes, youHero,
}: {
  teamLabel: string
  accent: Tone
  userRole: Role | null
  isUserTeam: boolean
  shape: SlotShape         // OTHER slots to fill (excludes the user's slot)
  pick: Record<Role, string[]>
  setPick: (p: Record<Role, string[]>) => void
  excludeHeroes?: string[]  // e.g. the anchor hero on the user's own team
  youHero?: string | null   // the hero you played, shown in the YOU slot
}) {
  function setSlot(role: Role, index: number, hero: string) {
    const next = { ...pick, [role]: [...pick[role]] }
    if (hero === '') next[role].splice(index, 1)
    else next[role][index] = hero
    // compact out holes
    next[role] = next[role].filter(Boolean)
    setPick(next)
  }

  // every hero already chosen on THIS team, plus any explicit exclusions
  // (the anchor hero). Used so a hero can't be picked twice.
  const taken = new Set<string>([
    ...pick.tank, ...pick.dps, ...pick.support, ...(excludeHeroes ?? []),
  ])

  const dot = accent === 'blue' ? 'bg-sky-400' : accent === 'red' ? 'bg-rose-400' : 'bg-emerald-400'

  return (
    <div className="bg-ow-bg rounded-md border border-ow-line p-3">
      <div className="flex items-center gap-2 mb-3">
        <span className={`w-2 h-2 rounded-full ${dot}`} />
        <span className="text-xs uppercase tracking-widest text-ow-muted">{teamLabel}</span>
      </div>
      <div className="space-y-2">
        {ROLES.map((role) => {
          const slots = shape[role]
          if (slots <= 0 && !(isUserTeam && userRole === role)) return null
          return (
            <div key={role} className="flex items-center gap-2">
              <span className="w-12 text-[11px] uppercase tracking-wider text-ow-faint">{ROLE_LABEL[role]}</span>
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: slots }).map((_, i) => {
                  const hero = pick[role][i] ?? ''
                  return (
                    <div key={i} className="flex flex-col items-center gap-1">
                      {hero
                        ? <HeroBox name={hero} size={56} />
                        : <div className="w-14 h-14 rounded-md border border-dashed border-ow-line bg-ow-panel" />}
                      <Select<string>
                        value={hero}
                        onChange={v => setSlot(role, i, v)}
                        className="text-[11px] max-w-[64px]"
                        options={[
                          { value: '', label: '—' },
                          ...getHeroesByRole(role)
                            .filter((h) => h.name === hero || !taken.has(h.name))
                            .map((h) => ({ value: h.name, label: h.name })),
                        ]}
                      />
                    </div>
                  )
                })}
                {/* the user's own slot is the RIGHTMOST box of its role */}
                {isUserTeam && userRole === role && (
                  <div className="flex flex-col items-center gap-1">
                    {youHero
                      ? <div className="rounded-md ring-2 ring-emerald-500/60"><HeroBox name={youHero} size={56} /></div>
                      : <div className="w-14 h-14 rounded-md border border-emerald-500/50 bg-emerald-500/10 flex items-center justify-center text-[10px] text-emerald-300">YOU</div>}
                    <span className="text-[10px] text-emerald-300 uppercase tracking-wider">you</span>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ResultBlock({ label, cell }: { label: string; cell: Cell | null }) {
  if (!cell) return null
  return (
    <div className="bg-ow-bg rounded-md p-4 border border-ow-line flex items-center justify-between">
      <div>
        <div className="text-sm text-ow-muted">{label}</div>
        <RecordLine cell={cell} />
        {cell.lowConfidence && cell.games > 0 && (
          <div className="text-[11px] text-amber-400/70 mt-1">Low confidence — under {CONFIDENCE_MIN_GAMES} games</div>
        )}
        {cell.games === 0 && <div className="text-[11px] text-ow-faint mt-1">No matching games — expected on a small sample.</div>}
      </div>
      <WinRateBadge cell={cell} big />
    </div>
  )
}

function ComboLab(props: {
  layout: 'ally' | 'enemy' | 'both'
  setLayout: (v: 'ally' | 'enemy' | 'both') => void
  format: Format
  userRole: Role | null
  labSixAlly: SlotShape
  setLabSixAlly: (s: SlotShape) => void
  labSixEnemy: SlotShape
  setLabSixEnemy: (s: SlotShape) => void
  liftSixAlly: SlotShape
  setLiftSixAlly: (s: SlotShape) => void
  liftSixEnemy: SlotShape
  setLiftSixEnemy: (s: SlotShape) => void
  allyPick: Record<Role, string[]>
  setAllyPick: (p: Record<Role, string[]>) => void
  enemyPick: Record<Role, string[]>
  setEnemyPick: (p: Record<Role, string[]>) => void
  allyMode: ComboMode
  setAllyMode: (m: ComboMode) => void
  enemyMode: ComboMode
  setEnemyMode: (m: ComboMode) => void
  allyResult: Cell | null
  enemyResult: Cell | null
  bothResult: Cell | null
  matrix: PairingMatrix | null
  anchorHero: string | null
  lift: LiftView
  liftBoth: LiftViewBoth
  liftMode: 'ally' | 'enemy' | 'both'
  setLiftMode: (m: 'ally' | 'enemy' | 'both') => void
  liftAllySet: string[]
  setLiftAllySet: (s: string[]) => void
  liftEnemySet: string[]
  setLiftEnemySet: (s: string[]) => void
}) {
  const {
    layout, setLayout, format, userRole,
    labSixAlly, setLabSixAlly, labSixEnemy, setLabSixEnemy,
    liftSixAlly, setLiftSixAlly, liftSixEnemy, setLiftSixEnemy,
    allyPick, setAllyPick, enemyPick, setEnemyPick,
    allyMode, setAllyMode, enemyMode, setEnemyMode,
    allyResult, enemyResult, bothResult, matrix, anchorHero,
    lift, liftBoth, liftMode, setLiftMode,
    liftAllySet, setLiftAllySet, liftEnemySet, setLiftEnemySet,
  } = props

  // OTHER-slots shape per LAB team (the user's slot is dropped on the
  // ally side; the enemy team uses the full shape). 6v6 uses each team's
  // own lab shape.
  const allyShape = userRole ? otherSlotShape(format, userRole, labSixAlly) : labSixAlly
  const enemyShape = format === '6v6' ? labSixEnemy : { tank: 1, dps: 2, support: 2 }
  // FULL team shapes for the LIFT columns (they reserve the user's role
  // themselves), per team.
  const liftFullAlly: SlotShape = format === '6v6' ? liftSixAlly : { tank: 1, dps: 2, support: 2 }
  const liftFullEnemy: SlotShape = format === '6v6' ? liftSixEnemy : { tank: 1, dps: 2, support: 2 }

  const showAlly = layout === 'ally' || layout === 'both'
  const showEnemy = layout === 'enemy' || layout === 'both'

  return (
    <div className="bg-ow-panel rounded-lg border border-ow-line overflow-hidden">
      <div className="px-4 py-3 border-b border-ow-line flex flex-wrap items-center gap-3">
        <h3 className="font-display tracking-wider text-ow-fg text-sm uppercase">Combination lab</h3>
        <Segmented
          value={layout}
          onChange={(v) => setLayout(v as 'ally' | 'enemy' | 'both')}
          toneByValue={{ ally: 'blue', enemy: 'red', both: 'green' }}
          options={[
            { value: 'ally', label: 'Ally team' },
            { value: 'enemy', label: 'Enemy team' },
            { value: 'both', label: 'Both' },
          ]}
        />
      </div>

      <div className="p-4 space-y-4">
        <p className="text-xs text-ow-faint">
          Build a team like a scoreboard, then read the win rate. Fill some slots for{' '}
          <strong className="text-ow-muted">co-occurrence</strong> (those heroes present, others
          allowed); fill every slot and switch to{' '}
          <strong className="text-ow-muted">exact comp</strong> for that precise team only.
        </p>

        <div className={`grid gap-4 ${layout === 'both' ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
          {showAlly && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-widest text-sky-300">Your team</span>
                <Segmented
                  value={allyMode} onChange={(v) => setAllyMode(v as ComboMode)} tone="green"
                  options={[{ value: 'cooccurrence', label: 'Co-occ.' }, { value: 'exact', label: 'Exact' }]}
                />
              </div>
              {format === '6v6' && (
                <SixShapeChooser shape={labSixAlly} setShape={setLabSixAlly} />
              )}
              <Scoreboard
                teamLabel="Allies" accent="blue" userRole={userRole}
                isUserTeam shape={allyShape} pick={allyPick} setPick={setAllyPick}
                excludeHeroes={anchorHero ? [anchorHero] : []}
                youHero={anchorHero}
              />
            </div>
          )}
          {showEnemy && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-widest text-rose-300">Enemy team</span>
                <Segmented
                  value={enemyMode} onChange={(v) => setEnemyMode(v as ComboMode)} tone="green"
                  options={[{ value: 'cooccurrence', label: 'Co-occ.' }, { value: 'exact', label: 'Exact' }]}
                />
              </div>
              {format === '6v6' && (
                <SixShapeChooser shape={labSixEnemy} setShape={setLabSixEnemy} />
              )}
              <Scoreboard
                teamLabel="Enemies" accent="red" userRole={null}
                isUserTeam={false} shape={enemyShape} pick={enemyPick} setPick={setEnemyPick}
              />
            </div>
          )}
        </div>

        {/* results */}
        <div className="space-y-3">
          {layout === 'ally' && <ResultBlock label="Win rate with this ally set" cell={allyResult} />}
          {layout === 'enemy' && <ResultBlock label="Win rate against this enemy set" cell={enemyResult} />}
          {layout === 'both' && <ResultBlock label="Win rate with these allies AND against these enemies" cell={bothResult} />}
        </div>

        {/* pairing matrix grid */}
        {matrix && matrix.rowHeroes.length > 0 && matrix.colHeroes.length > 0 && (
          <MatrixGrid
            matrix={matrix}
            cross={layout === 'both'}
            youHero={anchorHero}
          />
        )}

        {/* lift drill-down */}
        <LiftDrillDown
          lift={lift}
          liftBoth={liftBoth}
          mode={liftMode}
          setMode={setLiftMode}
          allySet={liftAllySet}
          setAllySet={setLiftAllySet}
          enemySet={liftEnemySet}
          setEnemySet={setLiftEnemySet}
          anchorHero={anchorHero}
          allyShape={liftFullAlly}
          enemyShape={liftFullEnemy}
          format={format}
          sixAlly={liftSixAlly}
          setSixAlly={setLiftSixAlly}
          sixEnemy={liftSixEnemy}
          setSixEnemy={setLiftSixEnemy}
        />
      </div>
    </div>
  )
}

// The lift drill-down: start from your hero, add teammates/enemies one
// at a time, ranked by how much each addition moves your win rate.
// Three modes: ally, enemy, or both (interleaved — one combined base,
// candidates from both sides ranked together).
function LiftDrillDown({
  lift, liftBoth, mode, setMode, allySet, setAllySet, enemySet, setEnemySet, anchorHero,
  allyShape, enemyShape, format, sixAlly, setSixAlly, sixEnemy, setSixEnemy,
}: {
  lift: LiftView
  liftBoth: LiftViewBoth
  mode: 'ally' | 'enemy' | 'both'
  setMode: (m: 'ally' | 'enemy' | 'both') => void
  allySet: string[]
  setAllySet: (s: string[]) => void
  enemySet: string[]
  setEnemySet: (s: string[]) => void
  anchorHero: string | null
  allyShape: SlotShape
  enemyShape: SlotShape
  format: Format
  sixAlly: SlotShape
  setSixAlly: (s: SlotShape) => void
  sixEnemy: SlotShape
  setSixEnemy: (s: SlotShape) => void
}) {
  function deltaColor(d: number | null): string {
    if (d == null) return 'text-ow-faint'
    if (d > 0) return 'text-emerald-300'
    if (d < 0) return 'text-rose-300'
    return 'text-ow-muted'
  }
  function deltaText(d: number | null): string {
    if (d == null) return '·'
    return (d > 0 ? '+' : '') + d.toFixed(2) + '%'
  }

  // the base cell + the ranked candidate rows depend on the mode.
  const baseCell = mode === 'both' ? liftBoth.base.cell : lift.base.cell
  const full = mode === 'both' ? liftBoth.full : lift.full

  // a row's click action: add to the right side's set.
  function addHero(hero: string, side: Relation) {
    if (side === 'ally') setAllySet([...allySet, hero])
    else setEnemySet([...enemySet, hero])
  }
  function resetAll() { setAllySet([]); setEnemySet([]) }

  // candidate rows, each tagged with the side it would join.
  const rows: { hero: string; cell: Cell; delta: number | null; side: Relation }[] =
    mode === 'both'
      ? liftBoth.candidates.map((c) => ({ hero: c.hero, cell: c.cell, delta: c.delta, side: c.relation }))
      : lift.candidates.map((c) => ({ hero: c.hero, cell: c.cell, delta: c.delta, side: (mode === 'enemy' ? 'enemy' : 'ally') as Relation }))

  // which sets to show in the two-column picker
  const showAlly = mode === 'ally' || mode === 'both'
  const showEnemy = mode === 'enemy' || mode === 'both'

  const sideBadge = (side: Relation) =>
    side === 'ally'
      ? <span className="text-[9px] uppercase tracking-wider text-sky-300 border border-sky-500/30 rounded px-1">ally</span>
      : <span className="text-[9px] uppercase tracking-wider text-rose-300 border border-rose-500/30 rounded px-1">enemy</span>

  // a scoreboard column for one side. Slots are grouped by role
  // (tank → dps → support). Within a role the slots sit left-to-right and
  // the user's slot is the RIGHTMOST. Portraits take ~40% width, the
  // per-slot role-locked selectors ~60%. 6v6 gets a per-side shape chooser.
  function SetColumn({ side, set }: { side: Relation; set: string[] }) {
    const accent = side === 'ally' ? 'text-sky-300' : 'text-rose-300'
    const shape = side === 'ally' ? allyShape : enemyShape
    const isUserSide = side === 'ally' && !!anchorHero
    const userRoleHere = isUserSide ? (HEROES.find((h) => h.name === anchorHero)?.role ?? null) : null
    // heroes unavailable to pick: everything already on this side + your hero
    const taken = new Set<string>([...set, ...(anchorHero && side === 'ally' ? [anchorHero] : [])])

    // picks of a given role, in order
    const picksOfRole = (role: Role) => set.filter((h) => HEROES.find((x) => x.name === h)?.role === role)

    function replacePick(role: Role, indexInRole: number, hero: string) {
      const ofRole = picksOfRole(role)
      const nextOfRole = [...ofRole]
      if (hero === '') nextOfRole.splice(indexInRole, 1)
      else nextOfRole[indexInRole] = hero
      // rebuild set preserving role grouping order tank→dps→support
      const rebuilt: string[] = []
      for (const r of ROLES) rebuilt.push(...(r === role ? nextOfRole : picksOfRole(r)))
      if (side === 'ally') setAllySet(rebuilt); else setEnemySet(rebuilt)
    }
    function addPick(hero: string) {
      if (!hero) return
      if (side === 'ally') setAllySet([...set, hero]); else setEnemySet([...set, hero])
    }

    return (
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-2">
          <div className={`text-[11px] uppercase tracking-widest ${accent}`}>
            {side === 'ally' ? 'Your team' : 'Enemy team'}
          </div>
          {format === '6v6' && (
            <SixShapeChooser
              shape={side === 'ally' ? sixAlly : sixEnemy}
              setShape={side === 'ally' ? setSixAlly : setSixEnemy}
            />
          )}
        </div>

        <div className="space-y-3">
          {ROLES.map((role) => {
            const slotCount = shape[role]
            if (slotCount <= 0) return null
            const ofRole = picksOfRole(role)
            // the user occupies the rightmost slot of their role
            const userOwnsLast = userRoleHere === role
            const fillable = userOwnsLast ? slotCount - 1 : slotCount  // non-you slots

            // build the ordered slot descriptors for this role row
            type Slot =
              | { kind: 'you' }
              | { kind: 'pick'; hero: string; indexInRole: number }
              | { kind: 'empty'; indexInRole: number }
            const slots: Slot[] = []
            for (let i = 0; i < fillable; i++) {
              if (i < ofRole.length) slots.push({ kind: 'pick', hero: ofRole[i], indexInRole: i })
              else slots.push({ kind: 'empty', indexInRole: i })
            }
            if (userOwnsLast) slots.push({ kind: 'you' })  // rightmost

            return (
              <div key={role}>
                <div className="text-[10px] uppercase tracking-widest text-ow-faint mb-1">{ROLE_LABEL[role]}</div>
                <div className="space-y-1.5">
                  {slots.map((slot, i) => (
                    <div key={i} className="flex items-center gap-2">
                      {/* portrait box ~40% */}
                      <div className="basis-2/5 flex justify-center">
                        {slot.kind === 'you' ? (
                          <div className="flex flex-col items-center gap-0.5">
                            <div className="rounded-md ring-2 ring-emerald-500/60">
                              <HeroBox name={anchorHero!} size={52} />
                            </div>
                            <span className="text-[9px] text-emerald-300 uppercase tracking-wider">you</span>
                          </div>
                        ) : slot.kind === 'pick' ? (
                          <div className="relative">
                            <HeroBox name={slot.hero} size={52} />
                            <button
                              onClick={() => replacePick(role, slot.indexInRole, '')}
                              className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-ow-panel border border-ow-line text-ow-muted hover:text-rose-300 text-[10px] leading-none flex items-center justify-center"
                              aria-label={`Remove ${slot.hero}`}
                            >×</button>
                          </div>
                        ) : (
                          <div className="w-[52px] h-[52px] rounded-md border border-dashed border-ow-line bg-ow-panel" />
                        )}
                      </div>

                      {/* selector ~60%, role-locked */}
                      <div className="basis-3/5 min-w-0">
                        {slot.kind === 'you' ? (
                          <div className="text-[11px] text-ow-faint px-1">Your hero ({anchorHero})</div>
                        ) : (
                          <Select<string>
                            value={slot.kind === 'pick' ? slot.hero : ''}
                            onChange={v => {
                              if (slot.kind === 'pick') replacePick(role, slot.indexInRole, v)
                              else addPick(v)
                            }}
                            className="w-full text-sm"
                            options={[
                              { value: '', label: `${ROLE_LABEL[role]} —` },
                              ...getHeroesByRole(role)
                                .filter((h) => (slot.kind === 'pick' && h.name === slot.hero) || !taken.has(h.name))
                                .map((h) => ({ value: h.name, label: h.name })),
                            ]}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="border-t border-ow-line pt-4 mt-2 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h4 className="font-display tracking-wider text-ow-fg text-sm uppercase">Combination lift</h4>
        <Segmented
          value={mode}
          onChange={(v) => { setMode(v as 'ally' | 'enemy' | 'both'); resetAll() }}
          toneByValue={{ ally: 'blue', enemy: 'red', both: 'green' }}
          options={[
            { value: 'ally', label: 'Allies' },
            { value: 'enemy', label: 'Enemies' },
            { value: 'both', label: 'Both' },
          ]}
        />
        {(allySet.length > 0 || enemySet.length > 0) && (
          <button onClick={resetAll} className="text-xs text-ow-faint hover:text-ow-muted">reset</button>
        )}
      </div>

      <p className="text-xs text-ow-faint">
        {mode === 'both'
          ? 'Build your team and the enemy team together; each candidate below shows how adding it — on either side — moves your win rate against the current combined base.'
          : `Start from ${mode === 'ally' ? 'your hero' : 'an empty enemy set'}, add one ${mode === 'ally' ? 'teammate' : 'opponent'} at a time, and see how each addition moves your win rate.`}
        {' '}Candidates are limited to the open role slots.
      </p>

      {/* vertical scoreboard columns: portraits stacked in role order +
          a picker per side. In Both mode the two sides sit side by side,
          giving four columns (ally portraits | ally picker | enemy
          portraits | enemy picker). */}
      <div className="bg-ow-bg rounded-md border border-ow-line p-3">
        <div className="flex flex-col sm:flex-row gap-4 sm:divide-x divide-white/10">
          {showAlly && <SetColumn side="ally" set={allySet} />}
          {showEnemy && <SetColumn side="enemy" set={enemySet} />}
        </div>
      </div>

      {/* base rate */}
      <div className="bg-ow-bg rounded-md p-3 border border-ow-line flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-ow-faint">Base set win rate</div>
          <RecordLine cell={baseCell} />
        </div>
        <WinRateBadge cell={baseCell} big />
      </div>

      {/* ranked candidates */}
      {full ? (
        <Muted>All role slots filled — no more heroes to add.</Muted>
      ) : (
        <>
          <div className="text-[11px] uppercase tracking-widest text-ow-faint">Add one more — ranked by lift</div>
          <div className="space-y-1.5">
            {rows.map((r) => (
              <button
                key={`${r.side}:${r.hero}`}
                onClick={() => addHero(r.hero, r.side)}
                className={
                  'w-full flex items-center gap-3 bg-ow-bg border border-ow-line rounded-md px-3 py-2 text-left hover:border-ow-line transition-colors ' +
                  (r.cell.lowConfidence && r.cell.games > 0 ? 'opacity-50' : '')
                }
              >
                <HeroBox name={r.hero} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ow-fg flex items-center gap-2">
                    {r.hero}{mode === 'both' && sideBadge(r.side)}
                  </div>
                  <RecordLine cell={r.cell} />
                </div>
                <div className="text-right">
                  <div className={`font-display tabular-nums text-sm ${r.cell.winRate == null ? 'text-ow-faint' : r.cell.winRate >= 55 ? 'text-emerald-300' : r.cell.winRate <= 45 ? 'text-rose-300' : 'text-ow-fg'}`}>
                    {r.cell.winRate == null ? '—' : r.cell.winRate.toFixed(0) + '%'}
                  </div>
                  <div className={`font-display tabular-nums text-sm ${deltaColor(r.delta)}`}>{deltaText(r.delta)}</div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// The pairing grid. Selected heroes label the axes; each cell is the
// win rate for that pairing. Same-relation matrices have a meaningful
// diagonal (solo rate); cross (Both) matrices don't.
function MatrixGrid({ matrix, cross, youHero }: { matrix: PairingMatrix; cross: boolean; youHero: string | null }) {
  function cellTint(c: MatrixCell): string {
    if (c.winRate == null) return 'text-ow-faint'
    if (c.winRate >= 55) return 'text-emerald-300'
    if (c.winRate <= 45) return 'text-rose-300'
    return 'text-ow-fg'
  }
  return (
    <div className="overflow-x-auto">
      <div className="text-[11px] uppercase tracking-widest text-ow-faint mb-2">
        Pairing grid {cross ? '(your team ↓ vs enemy →)' : '(win rate when both present; diagonal = solo)'}
      </div>
      <table className="border-collapse">
        <thead>
          <tr>
            <th className="p-1" />
            {matrix.colHeroes.map((h) => (
              <th key={h} className="p-1 align-bottom">
                <div className="flex flex-col items-center gap-1 w-14">
                  <div className={h === youHero ? 'rounded-md ring-2 ring-emerald-500/60' : ''}>
                    <HeroBox name={h} size={36} />
                  </div>
                  <span className={`text-[10px] leading-tight text-center truncate w-full ${h === youHero ? 'text-emerald-300' : 'text-ow-muted'}`}>
                    {h === youHero ? 'YOU' : h}
                  </span>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rowHeroes.map((rh, i) => (
            <tr key={rh}>
              <th className="p-1">
                <div className="flex items-center gap-2 pr-2">
                  <div className={rh === youHero ? 'rounded-md ring-2 ring-emerald-500/60' : ''}>
                    <HeroBox name={rh} size={36} />
                  </div>
                  <span className={`text-[11px] whitespace-nowrap ${rh === youHero ? 'text-emerald-300' : 'text-ow-muted'}`}>
                    {rh === youHero ? `${rh} (you)` : rh}
                  </span>
                </div>
              </th>
              {matrix.colHeroes.map((ch, j) => {
                const c = matrix.cells[i][j]
                const isDiag = !cross && c.isDiagonal
                return (
                  <td
                    key={ch}
                    className={
                      'text-center border border-ow-line w-14 h-12 ' +
                      (isDiag ? 'bg-white/5 ' : '') +
                      (c.lowConfidence && c.games > 0 ? 'opacity-50' : '')
                    }
                    title={
                      c.games === 0 ? 'No games'
                        : `${c.wins}W–${c.losses}L${c.draws ? `–${c.draws}D` : ''} · ${c.games} games`
                    }
                  >
                    <div className={`font-display tabular-nums text-xs ${cellTint(c)}`}>
                      {c.winRate == null ? '·' : c.winRate.toFixed(0) + '%'}
                    </div>
                    {c.games > 0 && (
                      <div className="text-[9px] text-ow-faint tabular-nums">{c.games}g</div>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-ow-faint mt-2">
        Cells show win rate (2dp in the lists above; rounded here) and game count. Faded = under{' '}
        {CONFIDENCE_MIN_GAMES} games. A dot means no games for that pairing yet.
      </p>
    </div>
  )
}

function SixShapeChooser({ shape, setShape }: { shape: SlotShape; setShape: (s: SlotShape) => void }) {
  function bump(role: Role, delta: number) {
    // Tank is capped at 2 (Overwatch's max-2-tanks rule); dps/support clamp 0-6.
    const max = role === 'tank' ? 2 : 6
    const next = { ...shape, [role]: Math.max(0, Math.min(max, shape[role] + delta)) }
    setShape(next)
  }
  return (
    <div className="flex items-center gap-2 text-xs text-ow-muted">
      <span>6v6 shape:</span>
      {ROLES.map((role) => (
        <span key={role} className="inline-flex items-center gap-1 bg-ow-bg border border-ow-line rounded px-1.5 py-0.5">
          {ROLE_LABEL[role]}
          <button onClick={() => bump(role, -1)} className="text-ow-faint hover:text-ow-fg px-1">−</button>
          <span className="tabular-nums w-3 text-center text-ow-muted">{shape[role]}</span>
          <button onClick={() => bump(role, 1)} className="text-ow-faint hover:text-ow-fg px-1">+</button>
        </span>
      ))}
    </div>
  )
}

function SparsityNote({ pairs, anchor, mf }: { pairs: PairRow[]; anchor: string | null; mf: MatchupFilters }) {
  const games = useMemo(() => {
    const ids = new Set<number>()
    for (const p of pairs) {
      if (anchor !== null && p.anchor_hero !== anchor) continue
      if (mf.queue === '6v6' && p.match_format !== '6v6') continue
      if (mf.queue !== 'all' && mf.queue !== '6v6'
        && !(p.match_format === '5v5' && p.user_role_played === mf.queue)) continue
      if (mf.mode !== 'all' && p.game_mode !== mf.mode) continue
      if (mf.map !== 'all' && p.map !== mf.map) continue
      ids.add(p.match_id)
    }
    return ids.size
  }, [pairs, anchor, mf])

  return (
    <p className="text-xs text-ow-faint">
      Based on {games} {games === 1 ? 'game' : 'games'} in the current selection.
      {games < 20 && ' Small sample — read the dimmed rows with caution.'}
    </p>
  )
}
