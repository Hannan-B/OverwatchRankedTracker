'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import {
  MAPS, HEROES, GAME_MODE_CONFIG,
  getGameModeForMap, needsStartingSide, getHeroesByRole,
  type GameMode
} from '@/data/reference'
import type {
  MatchResult, RoleType, StartingSide,
  MatchFeel, PerformanceFeel, NotableEvent
} from '@/lib/types'

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
              : 'bg-ow-dark text-slate-400 border border-white/10 hover:text-white hover:border-white/20'
            }`}
        >
          {labels[opt]}
        </button>
      ))}
    </div>
  )
}

function MultiChipSelect<T extends string>({
  options,
  value,
  onChange,
  labels,
}: {
  options: T[]
  value: T[]
  onChange: (v: T[]) => void
  labels: Record<T, string>
}) {
  function toggle(opt: T) {
    if (value.includes(opt)) {
      onChange(value.filter(v => v !== opt))
    } else {
      onChange([...value, opt])
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {options.map(opt => (
        <button
          key={opt}
          type="button"
          onClick={() => toggle(opt)}
          className={`px-4 py-2 rounded-lg text-sm font-display tracking-wider transition-all
            ${value.includes(opt)
              ? 'bg-ow-orange text-ow-dark font-bold'
              : 'bg-ow-dark text-slate-400 border border-white/10 hover:text-white hover:border-white/20'
            }`}
        >
          {labels[opt]}
        </button>
      ))}
    </div>
  )
}

function StarRating({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map(star => (
        <button
          key={star}
          type="button"
          onClick={() => onChange(value === star ? null : star)}
          className={`text-2xl transition-colors ${
            value && star <= value ? 'text-ow-orange' : 'text-slate-600 hover:text-slate-400'
          }`}
        >
          ★
        </button>
      ))}
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
          <div key={i} className="flex items-center justify-between bg-ow-dark rounded-lg px-4 py-2 border border-white/10">
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-500 font-display">#{i + 1}</span>
              <span className="text-white font-display">{hero}</span>
            </div>
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="text-slate-500 hover:text-ow-defeat transition-colors text-sm"
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
            className="w-full border border-dashed border-white/10 rounded-lg py-3
                       text-slate-400 hover:text-white hover:border-white/20
                       font-display tracking-wider text-sm transition-colors"
          >
            + ADD HERO
          </button>

          {showPicker && (
            <div className="mt-2 bg-ow-dark rounded-lg border border-white/10 p-3 max-h-60 overflow-y-auto">
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
                      className="text-left px-3 py-2 rounded text-sm text-slate-300
                                 hover:bg-ow-panel hover:text-white transition-colors"
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

  // Qualitative
  const [matchFeel, setMatchFeel] = useState<MatchFeel | null>(null)
  const [perfFeel, setPerfFeel] = useState<PerformanceFeel | null>(null)
  const [notableEvents, setNotableEvents] = useState<NotableEvent[]>([])
  const [funRating, setFunRating] = useState<number | null>(null)
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
          match_feel: matchFeel,
          performance_feel: perfFeel,
          notable_events: notableEvents.length > 0 ? notableEvents : null,
          fun_rating: funRating,
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
        <p className="text-sm text-slate-400 mt-1">Enter your match details</p>
      </div>

      {/* ======================== MAP ======================== */}
      <SectionHeader>MAP</SectionHeader>
      <select
        value={map}
        onChange={e => {
          setMap(e.target.value)
          setStartingSide(null)
        }}
        className="w-full bg-ow-dark border border-white/10 rounded-lg px-4 py-3
                   text-white focus:border-ow-orange/50 focus:outline-none appearance-none"
      >
        <option value="">Select a map...</option>
        {mapsByMode.map(([mode, maps]) => (
          <optgroup key={mode} label={mode.charAt(0).toUpperCase() + mode.slice(1)}>
            {maps.sort((a, b) => a.name.localeCompare(b.name)).map(m => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
          </optgroup>
        ))}
      </select>

      {map && (
        <p className="text-xs text-slate-500">
          Mode: {gameMode?.charAt(0).toUpperCase()}{gameMode?.slice(1)}
          {showStartingSide ? ' (asymmetric)' : ' (symmetric)'}
        </p>
      )}

      {/* Starting side (only for asymmetric maps) */}
      {showStartingSide && (
        <div className="mt-2">
          <label className="block text-xs text-slate-400 font-display tracking-wider mb-2">
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
        <label className="block text-xs text-slate-400 font-display tracking-wider mb-2">
          SCORE
        </label>
        <input
          type="text"
          value={score}
          onChange={e => setScore(e.target.value)}
          placeholder="e.g. 3-2, 1-0, 2 VS 3"
          className="w-full bg-ow-dark border border-white/10 rounded-lg px-4 py-2.5
                     text-white placeholder-slate-600 focus:border-ow-orange/50
                     focus:outline-none transition-colors"
        />
      </div>

      {/* Game length */}
      <div className="mt-2">
        <label className="block text-xs text-slate-400 font-display tracking-wider mb-2">
          GAME LENGTH
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={gameLengthMin}
            onChange={e => setGameLengthMin(e.target.value)}
            placeholder="Min"
            className="w-20 bg-ow-dark border border-white/10 rounded-lg px-3 py-2.5
                       text-white text-center placeholder-slate-600 focus:border-ow-orange/50
                       focus:outline-none transition-colors"
          />
          <span className="text-slate-500">:</span>
          <input
            type="number"
            value={gameLengthSec}
            onChange={e => setGameLengthSec(e.target.value)}
            placeholder="Sec"
            className="w-20 bg-ow-dark border border-white/10 rounded-lg px-3 py-2.5
                       text-white text-center placeholder-slate-600 focus:border-ow-orange/50
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
          <label className="block text-xs text-slate-400 font-display tracking-wider mb-1 text-center">
            ELIMS
          </label>
          <input
            type="number"
            value={elims}
            onChange={e => setElims(e.target.value)}
            placeholder="—"
            className="w-full bg-ow-dark border border-white/10 rounded-lg px-3 py-2.5
                       text-white text-center placeholder-slate-600 focus:border-ow-orange/50
                       focus:outline-none transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 font-display tracking-wider mb-1 text-center">
            ASSISTS
          </label>
          <input
            type="number"
            value={assists}
            onChange={e => setAssists(e.target.value)}
            placeholder="—"
            className="w-full bg-ow-dark border border-white/10 rounded-lg px-3 py-2.5
                       text-white text-center placeholder-slate-600 focus:border-ow-orange/50
                       focus:outline-none transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 font-display tracking-wider mb-1 text-center">
            DEATHS
          </label>
          <input
            type="number"
            value={deaths}
            onChange={e => setDeaths(e.target.value)}
            placeholder="—"
            className="w-full bg-ow-dark border border-white/10 rounded-lg px-3 py-2.5
                       text-white text-center placeholder-slate-600 focus:border-ow-orange/50
                       focus:outline-none transition-colors"
          />
        </div>
      </div>

      {/* ======================== QUALITATIVE ======================== */}
      <SectionHeader>HOW DID IT FEEL?</SectionHeader>

      <div className="space-y-4">
        <div>
          <label className="block text-xs text-slate-400 font-display tracking-wider mb-2">
            MATCH FEEL
          </label>
          <ChipSelect
            options={['stomped_them', 'close_game', 'got_stomped'] as MatchFeel[]}
            value={matchFeel}
            onChange={setMatchFeel}
            labels={{
              stomped_them: 'STOMPED THEM',
              close_game: 'CLOSE GAME',
              got_stomped: 'GOT STOMPED',
            }}
          />
        </div>

        <div>
          <label className="block text-xs text-slate-400 font-display tracking-wider mb-2">
            YOUR PERFORMANCE
          </label>
          <ChipSelect
            options={['carried', 'did_my_job', 'struggled'] as PerformanceFeel[]}
            value={perfFeel}
            onChange={setPerfFeel}
            labels={{
              carried: 'CARRIED',
              did_my_job: 'DID MY JOB',
              struggled: 'STRUGGLED',
            }}
          />
        </div>

        <div>
          <label className="block text-xs text-slate-400 font-display tracking-wider mb-2">
            NOTABLE EVENTS
          </label>
          <MultiChipSelect
            options={['leaver', 'smurf', 'thrower', 'great_teamwork'] as NotableEvent[]}
            value={notableEvents}
            onChange={setNotableEvents}
            labels={{
              leaver: 'LEAVER',
              smurf: 'SMURF',
              thrower: 'THROWER',
              great_teamwork: 'GREAT TEAMWORK',
            }}
          />
        </div>

        <div>
          <label className="block text-xs text-slate-400 font-display tracking-wider mb-2">
            FUN RATING
          </label>
          <StarRating value={funRating} onChange={setFunRating} />
        </div>

        <div>
          <label className="block text-xs text-slate-400 font-display tracking-wider mb-2">
            PERSONAL THOUGHTS
          </label>
          <textarea
            value={thoughts}
            onChange={e => setThoughts(e.target.value)}
            placeholder="What happened this match? What could you improve?"
            rows={3}
            className="w-full bg-ow-dark border border-white/10 rounded-lg px-4 py-2.5
                       text-white placeholder-slate-600 focus:border-ow-orange/50
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
