'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import Select from '@/components/Select'
import {
  MAPS, HEROES, GAME_MODE_CONFIG,
  getGameModeForMap, needsStartingSide, getHeroesByRole,
  type GameMode
} from '@/data/reference'
import type {
  MatchResult, RoleType, StartingSide,
} from '@/lib/types'

// ============================================================
// MANUAL MATCH ENTRY
//
// (v1.1.0) QUESTION SET REBUILT — question scale version 2, matching
// upload/page.tsx. See PATCH-SPEC-v1.1.0.md §3.
//
// WHY THIS FORM WRITES VERSION 2 UNCONDITIONALLY, rather than asking the
// current season which scale it is on: the phone hardcodes
// question_scale_version: 2, so a season-aware form here would let the two
// capture surfaces disagree with each other — the same match logged two ways
// would land in different columns. The guard against writing version-2 answers
// into a version-1 season lives in Settings, where the per-season Q1/Q2 badge
// turns red when the season being actively played carries a different version
// than the app writes. Create the new season with version 2 before playing and
// this form is correct; do it the other way round and Settings will say so.
//
// The OLD columns (match_feel, performance_feel, fun_rating, tilt_mood, tempo,
// coordination) are FROZEN, not dropped. They keep their Season 3 data and are
// no longer written by anything. Do NOT map these answers onto them — the
// scales differ and the two sets are never pooled.
// ============================================================

/** Q1 — "How did you feel your team matched up against the enemy?"
 *  KEEPS ITS MIDPOINT, unlike fun. "Okay" was a dumping ground on the fun
 *  scale, but here the midpoint IS the signal: "evenly matched" is the exact
 *  state the founding hypothesis (a tight loss is still fun) is about, so
 *  removing it would delete the thing being measured.
 *  Measures TEAM STRENGTH, not result — "Behind" plus a victory is a
 *  legitimate and interesting combination. */
const MATCHUP_SCALE = [
  { value: 1, label: 'OUTCLASSED', test: 'Never had a chance' },
  { value: 2, label: 'BEHIND',     test: 'They had the edge throughout' },
  { value: 3, label: 'EVEN',       test: 'Genuinely contested' },
  { value: 4, label: 'AHEAD',      test: 'We had the edge throughout' },
  { value: 5, label: 'DOMINANT',   test: 'Never in doubt' },
]

/** Q2 — "How did you play?"
 *  ⚠️ WATCH: if "Did my job" exceeds 40% of answers it is behaving like the
 *  old fun 3/4 pair and should be cut to four points at the next boundary. */
const PERFORMANCE_SCALE = [
  { value: 1, label: 'OFF MY GAME', test: 'I was part of the problem' },
  { value: 2, label: 'BELOW PAR',   test: 'Not my usual standard' },
  { value: 3, label: 'DID MY JOB',  test: 'Normal game for me' },
  { value: 4, label: 'PLAYED WELL', test: 'Better than usual' },
  { value: 5, label: 'CARRIED',     test: 'I was the reason we were in it' },
]

/** Q3 — Fun. SIX points, deliberately NO midpoint.
 *  A 7-point scale has a centre and a centre becomes the default. Six has no
 *  middle — it falls between 3 and 4 — so every answer must lean one way. The
 *  scale is one binary question (did I enjoy this?) with two intensity steps
 *  either side, and the 3/4 boundary is the whole decision.
 *  Accepted trade-off: some games genuinely are neutral. A neutral bucket does
 *  not record indifference, it absorbs every answer not worth thinking about. */
const FUN_SCALE = [
  { value: 1, label: 'MISERABLE', test: 'I wanted to stop playing' },
  { value: 2, label: 'BAD',       test: 'Actively unpleasant, but I saw it out' },
  { value: 3, label: 'POOR',      test: "No, I didn't enjoy that" },
  { value: 4, label: 'GOOD',      test: 'Yes, I enjoyed that' },
  { value: 5, label: 'GREAT',     test: "I'd happily play that again" },
  { value: 6, label: 'BRILLIANT', test: 'Memorable — the reason I play' },
]

// ============================================================
// SUB-COMPONENTS
// ============================================================

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-lg font-display text-ow-orange tracking-wider mt-6 mb-3">
      {children}
    </h2>
  )
}

function ChipSelect<T extends string>({
  options,
  value,
  onChange,
  labels,
  colors,
}: {
  options: T[]
  value: T | null
  onChange: (v: T | null) => void
  labels: Record<T, string>
  colors?: Record<T, string>
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(opt => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(value === opt ? null : opt)}
          className={`px-4 py-2 rounded-lg text-sm font-display tracking-wider transition-all
            ${value === opt
              ? `${colors?.[opt] || 'bg-ow-orange text-ow-dark'} font-bold`
              : 'bg-ow-dark text-ow-muted border border-ow-line hover:text-ow-fg hover:border-ow-line'
            }`}
        >
          {labels[opt]}
        </button>
      ))}
    </div>
  )
}

/**
 * A behaviourally-anchored rating scale.
 *
 * Each point carries a TEST — a one-second decision — rather than an intensity
 * word. Abstract words (poor / fair / decent) reproduce the coin-flip that made
 * the old fun 3 and 4 interchangeable, holding 128 of 192 answers between them.
 * The wording here is deliberately IDENTICAL to upload/page.tsx: a manually
 * logged match and an uploaded one must mean the same thing by "4", or the two
 * capture routes quietly measure different quantities.
 *
 * Stars were REMOVED from the fun question on purpose. A star strip invites a
 * lazy middle, which is the exact failure being designed out.
 */
function ScaleSelect({
  options,
  value,
  onChange,
}: {
  options: { value: number; label: string; test: string }[]
  value: number | null
  onChange: (v: number | null) => void
}) {
  return (
    <div className="space-y-1.5">
      {options.map(opt => {
        const selected = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(selected ? null : opt.value)}
            className={`w-full text-left px-4 py-2.5 rounded-lg border transition-all
              ${selected
                ? 'bg-ow-orange/15 border-ow-orange/50'
                : 'bg-ow-dark border-ow-line hover:border-ow-line hover:bg-ow-panel'
              }`}
          >
            <span className={`font-display tracking-wider text-sm
              ${selected ? 'text-ow-orange font-bold' : 'text-ow-fg'}`}>
              {opt.value}. {opt.label}
            </span>
            <span className="block text-xs text-ow-faint mt-0.5">{opt.test}</span>
          </button>
        )
      })}
    </div>
  )
}

function HeroSelector({
  role,
  selectedHeroes,
  onAdd,
  onRemove,
}: {
  role: RoleType
  selectedHeroes: string[]
  onAdd: (hero: string) => void
  onRemove: (index: number) => void
}) {
  const [showPicker, setShowPicker] = useState(false)
  const heroes = getHeroesByRole(role)

  return (
    <div>
      {/* Selected heroes */}
      <div className="space-y-2 mb-3">
        {selectedHeroes.map((hero, i) => (
          <div key={i} className="flex items-center justify-between bg-ow-dark rounded-lg px-4 py-2 border border-ow-line">
            <div className="flex items-center gap-3">
              <span className="text-xs text-ow-faint font-display">#{i + 1}</span>
              <span className="text-ow-fg font-display">{hero}</span>
            </div>
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="text-ow-faint hover:text-ow-defeat transition-colors text-sm"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* Add hero button */}
      {selectedHeroes.length < 3 && (
        <>
          <button
            type="button"
            onClick={() => setShowPicker(!showPicker)}
            className="w-full border border-dashed border-ow-line rounded-lg py-3
                       text-ow-muted hover:text-ow-fg hover:border-ow-line
                       font-display tracking-wider text-sm transition-colors"
          >
            + ADD HERO
          </button>

          {showPicker && (
            <div className="mt-2 bg-ow-dark rounded-lg border border-ow-line p-3 max-h-60 overflow-y-auto">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
                {heroes
                  .filter(h => !selectedHeroes.includes(h.name))
                  .map(hero => (
                    <button
                      key={hero.name}
                      type="button"
                      onClick={() => {
                        onAdd(hero.name)
                        setShowPicker(false)
                      }}
                      className="text-left px-3 py-2 rounded text-sm text-ow-muted
                                 hover:bg-ow-panel hover:text-ow-fg transition-colors"
                    >
                      {hero.name}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ============================================================
// MAIN FORM
// ============================================================

export default function NewMatchPage() {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Match details
  const [map, setMap] = useState('')
  const [result, setResult] = useState<MatchResult | null>(null)
  const [score, setScore] = useState('')
  const [role, setRole] = useState<RoleType | null>(null)
  const [gameLengthMin, setGameLengthMin] = useState('')
  const [gameLengthSec, setGameLengthSec] = useState('')
  const [startingSide, setStartingSide] = useState<StartingSide | null>(null)

  // Performance
  const [elims, setElims] = useState('')
  const [assists, setAssists] = useState('')
  const [deaths, setDeaths] = useState('')

  // Heroes
  const [heroes, setHeroes] = useState<string[]>([])

  // Qualitative — question scale version 2 (see the header comment)
  const [matchupFeel, setMatchupFeel] = useState<number | null>(null)
  const [perfRating, setPerfRating] = useState<number | null>(null)
  const [funRating6, setFunRating6] = useState<number | null>(null)
  const [thoughts, setThoughts] = useState('')

  // Load default role from settings
  useEffect(() => {
    async function loadDefaults() {
      const { data } = await supabase
        .from('user_settings')
        .select('default_role')
        .limit(1)
        .single()
      if (data?.default_role && !role) {
        setRole(data.default_role)
      }
    }
    loadDefaults()
  }, [])

  // Derived values
  const gameMode = map ? getGameModeForMap(map) : undefined
  const showStartingSide = map ? needsStartingSide(map) : false
  const gameLengthSeconds = gameLengthMin || gameLengthSec
    ? (parseInt(gameLengthMin || '0') * 60) + parseInt(gameLengthSec || '0')
    : null

  // Group maps by mode for the picker
  const mapsByMode = Object.entries(
    MAPS.reduce((acc, m) => {
      if (!acc[m.mode]) acc[m.mode] = []
      acc[m.mode].push(m)
      return acc
    }, {} as Record<string, typeof MAPS>)
  )

  async function handleSave() {
    // Validation
    if (!map) return setError('Select a map')
    if (!result) return setError('Select a result')
    if (!role) return setError('Select a role')
    if (heroes.length === 0) return setError('Add at least one hero')

    setSaving(true)
    setError(null)

    try {
      // Get season
      const { data: seasonId } = await supabase
        .rpc('get_season_for_date', { match_date: new Date().toISOString() })

      // Insert match
      const { data: match, error: matchError } = await supabase
        .from('matches')
        .insert({
          map,
          game_mode: gameMode || null,
          result,
          score: score || null,
          role_played: role,
          game_length_seconds: gameLengthSeconds,
          starting_side: showStartingSide ? startingSide : null,
          season_id: seasonId || null,
          total_eliminations: elims ? parseInt(elims) : null,
          total_assists: assists ? parseInt(assists) : null,
          total_deaths: deaths ? parseInt(deaths) : null,
          // Scale version 2 columns ONLY. The version-1 columns are frozen and
          // are left null on every new row — writing both sets would put two
          // incompatible scales in one match, which is what the separate
          // columns exist to prevent.
          matchup_feel: matchupFeel,
          performance_rating: perfRating,
          fun_rating_6: funRating6,
          personal_thoughts: thoughts || null,
        })
        .select('id')
        .single()

      if (matchError) throw matchError

      // Insert hero performances
      if (match) {
        const heroInserts = heroes.map((heroName, i) => ({
          match_id: match.id,
          hero_name: heroName,
          display_order: i + 1,
        }))

        const { error: heroError } = await supabase
          .from('hero_performances')
          .insert(heroInserts)

        if (heroError) throw heroError
      }

      router.push('/matches')
    } catch (err: any) {
      setError(err.message || 'Failed to save match')
      setSaving(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto space-y-2 pb-8">
      <div>
        <h1 className="text-3xl text-ow-orange">Log Match</h1>
        <p className="text-sm text-ow-muted mt-1">Enter your match details</p>
      </div>

      {/* ======================== MAP ======================== */}
      <SectionHeader>MAP</SectionHeader>
      <Select<string>
        value={map}
        onChange={m => { setMap(m); setStartingSide(null) }}
        placeholder="Select a map..."
        className="w-full"
        options={mapsByMode.flatMap(([, maps]) =>
          maps.slice().sort((a, b) => a.name.localeCompare(b.name)).map(m => ({ value: m.name, label: m.name })),
        )}
      />

      {map && (
        <p className="text-xs text-ow-faint">
          Mode: {gameMode?.charAt(0).toUpperCase()}{gameMode?.slice(1)}
          {showStartingSide ? ' (asymmetric)' : ' (symmetric)'}
        </p>
      )}

      {/* Starting side (only for asymmetric maps) */}
      {showStartingSide && (
        <div className="mt-2">
          <label className="block text-xs text-ow-muted font-display tracking-wider mb-2">
            STARTING SIDE
          </label>
          <ChipSelect
            options={['attack', 'defense'] as StartingSide[]}
            value={startingSide}
            onChange={setStartingSide}
            labels={{ attack: 'ATTACK', defense: 'DEFENSE' }}
          />
        </div>
      )}

      {/* ======================== RESULT ======================== */}
      <SectionHeader>RESULT</SectionHeader>
      <ChipSelect
        options={['victory', 'defeat', 'draw'] as MatchResult[]}
        value={result}
        onChange={setResult}
        labels={{ victory: 'VICTORY', defeat: 'DEFEAT', draw: 'DRAW' }}
        colors={{
          victory: 'bg-ow-victory/20 text-ow-victory border border-ow-victory/30',
          defeat: 'bg-ow-defeat/20 text-ow-defeat border border-ow-defeat/30',
          draw: 'bg-ow-draw/20 text-ow-draw border border-ow-draw/30',
        }}
      />

      {/* Score */}
      <div className="mt-2">
        <label className="block text-xs text-ow-muted font-display tracking-wider mb-2">
          SCORE
        </label>
        <input
          type="text"
          value={score}
          onChange={e => setScore(e.target.value)}
          placeholder="e.g. 3-2, 1-0, 2 VS 3"
          className="w-full bg-ow-dark border border-ow-line rounded-lg px-4 py-2.5
                     text-ow-fg placeholder-ow-faint focus:border-ow-orange/50
                     focus:outline-none transition-colors"
        />
      </div>

      {/* Game length */}
      <div className="mt-2">
        <label className="block text-xs text-ow-muted font-display tracking-wider mb-2">
          GAME LENGTH
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={gameLengthMin}
            onChange={e => setGameLengthMin(e.target.value)}
            placeholder="Min"
            className="w-20 bg-ow-dark border border-ow-line rounded-lg px-3 py-2.5
                       text-ow-fg text-center placeholder-ow-faint focus:border-ow-orange/50
                       focus:outline-none transition-colors"
          />
          <span className="text-ow-faint">:</span>
          <input
            type="number"
            value={gameLengthSec}
            onChange={e => setGameLengthSec(e.target.value)}
            placeholder="Sec"
            className="w-20 bg-ow-dark border border-ow-line rounded-lg px-3 py-2.5
                       text-ow-fg text-center placeholder-ow-faint focus:border-ow-orange/50
                       focus:outline-none transition-colors"
          />
        </div>
      </div>

      {/* ======================== ROLE ======================== */}
      <SectionHeader>ROLE</SectionHeader>
      <ChipSelect
        options={['tank', 'dps', 'support'] as RoleType[]}
        value={role}
        onChange={v => {
          setRole(v)
          setHeroes([]) // Clear heroes when role changes
        }}
        labels={{ tank: 'TANK', dps: 'DPS', support: 'SUPPORT' }}
      />

      {/* ======================== HEROES ======================== */}
      {role && (
        <>
          <SectionHeader>HEROES PLAYED</SectionHeader>
          <HeroSelector
            role={role}
            selectedHeroes={heroes}
            onAdd={hero => setHeroes([...heroes, hero])}
            onRemove={i => setHeroes(heroes.filter((_, idx) => idx !== i))}
          />
        </>
      )}

      {/* ======================== PERFORMANCE ======================== */}
      <SectionHeader>PERFORMANCE</SectionHeader>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs text-ow-muted font-display tracking-wider mb-1 text-center">
            ELIMS
          </label>
          <input
            type="number"
            value={elims}
            onChange={e => setElims(e.target.value)}
            placeholder="—"
            className="w-full bg-ow-dark border border-ow-line rounded-lg px-3 py-2.5
                       text-ow-fg text-center placeholder-ow-faint focus:border-ow-orange/50
                       focus:outline-none transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs text-ow-muted font-display tracking-wider mb-1 text-center">
            ASSISTS
          </label>
          <input
            type="number"
            value={assists}
            onChange={e => setAssists(e.target.value)}
            placeholder="—"
            className="w-full bg-ow-dark border border-ow-line rounded-lg px-3 py-2.5
                       text-ow-fg text-center placeholder-ow-faint focus:border-ow-orange/50
                       focus:outline-none transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs text-ow-muted font-display tracking-wider mb-1 text-center">
            DEATHS
          </label>
          <input
            type="number"
            value={deaths}
            onChange={e => setDeaths(e.target.value)}
            placeholder="—"
            className="w-full bg-ow-dark border border-ow-line rounded-lg px-3 py-2.5
                       text-ow-fg text-center placeholder-ow-faint focus:border-ow-orange/50
                       focus:outline-none transition-colors"
          />
        </div>
      </div>

      {/* ======================== QUALITATIVE ======================== */}
      <SectionHeader>HOW DID IT FEEL?</SectionHeader>

      <div className="space-y-5">
        <div>
          <label className="block text-xs text-ow-muted font-display tracking-wider mb-2">
            HOW DID YOU FEEL YOUR TEAM MATCHED UP AGAINST THE ENEMY?
          </label>
          <ScaleSelect
            options={MATCHUP_SCALE}
            value={matchupFeel}
            onChange={setMatchupFeel}
          />
        </div>

        <div>
          <label className="block text-xs text-ow-muted font-display tracking-wider mb-2">
            HOW DID YOU PLAY?
          </label>
          <ScaleSelect
            options={PERFORMANCE_SCALE}
            value={perfRating}
            onChange={setPerfRating}
          />
        </div>

        <div>
          <label className="block text-xs text-ow-muted font-display tracking-wider mb-2">
            HOW MUCH DID YOU ENJOY IT?
          </label>
          <ScaleSelect
            options={FUN_SCALE}
            value={funRating6}
            onChange={setFunRating6}
          />
        </div>

        <div>
          <label className="block text-xs text-ow-muted font-display tracking-wider mb-2">
            PERSONAL THOUGHTS
          </label>
          <textarea
            value={thoughts}
            onChange={e => setThoughts(e.target.value)}
            placeholder="What happened this match? What could you improve?"
            rows={3}
            className="w-full bg-ow-dark border border-ow-line rounded-lg px-4 py-2.5
                       text-ow-fg placeholder-ow-faint focus:border-ow-orange/50
                       focus:outline-none transition-colors resize-none"
          />
        </div>
      </div>

      {/* ======================== SAVE ======================== */}
      {error && (
        <div className="bg-ow-defeat/10 border border-ow-defeat/30 rounded-lg px-4 py-3 text-sm text-ow-defeat">
          {error}
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full bg-ow-orange hover:bg-ow-accent disabled:bg-slate-700
                   disabled:text-slate-500 text-ow-dark font-display font-bold
                   py-3 rounded-lg tracking-wider transition-colors text-sm mt-6"
      >
        {saving ? 'SAVING...' : 'SAVE MATCH'}
      </button>
    </div>
  )
}
