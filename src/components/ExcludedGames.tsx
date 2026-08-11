'use client'

import { useEffect, useState } from 'react'
import {
  loadExclusionPrefs, setExclusionPref,
  type ExclusionPrefs, type ExclusionKey,
} from '@/lib/leaver'

// ============================================================
// EXCLUDED GAMES (Settings) — three visibility switches
// ------------------------------------------------------------
// (v1.1.0) Replaces the single LeaverToggle. That switch meant "show any match
// with a leaver", which bundled together three genuinely different situations:
//
//   • A PERMANENT leaver leaves the scoreboard a row short, so no scoreboard
//     was stored for the match at all.
//   • A RETURNED leaver's scoreboard is complete — only the numbers are skewed.
//   • A THROWER's scoreboard is entirely valid. Nothing is wrong with the data.
//
// The third is the important one to keep separate: excluding throwers is a
// PREFERENCE, not a data-integrity rule, which is why those games are still
// processed and stored in full and only hidden at read time.
//
// These apply to the PERFORMANCE surfaces (Home, Outcomes, Combat, Time,
// Heroes, Matchups, Pairings). Feel and the Builder always show every game —
// they analyse these games deliberately — as do the Home leaver count boxes.
//
// Stored in user_settings, not localStorage: a real preference that applies on
// live and follows you across devices. Flipping any switch persists all three
// (see setExclusionPref), so the stored row always matches what is on screen.
// ============================================================

interface SwitchSpec {
  key: ExclusionKey
  label: string
  detail: string
}

const SWITCHES: SwitchSpec[] = [
  {
    key: 'showPermanentLeavers',
    label: 'Leavers who never returned',
    detail: 'Someone left and stayed gone, so the scoreboard was a row short and none of it could be read. Only the summary and hero breakdown exist for these games.',
  },
  {
    key: 'showReturnedLeavers',
    label: 'Leavers who returned',
    detail: 'Someone left and came back. The scoreboard is complete and was saved in full — but their numbers are short by however long they were away.',
  },
  {
    key: 'showThrowers',
    label: 'Throwers',
    detail: 'Nothing is wrong with the data here; the game was just spoiled. Covers both teams. Hidden by default from this release — flip this first if a number looks off.',
  },
]

export default function ExcludedGames() {
  const [prefs, setPrefs] = useState<ExclusionPrefs>({
    showPermanentLeavers: false,
    showReturnedLeavers: false,
    showThrowers: false,
  })
  const [loaded, setLoaded] = useState(false)
  const [savingKey, setSavingKey] = useState<ExclusionKey | null>(null)

  useEffect(() => {
    let active = true
    loadExclusionPrefs().then(p => {
      if (active) { setPrefs(p); setLoaded(true) }
    })
    return () => { active = false }
  }, [])

  async function toggle(key: ExclusionKey) {
    const next = !prefs[key]
    setPrefs(p => ({ ...p, [key]: next }))   // optimistic; the module caches it too
    setSavingKey(key)
    const updated = await setExclusionPref(key, next)
    setPrefs(updated)
    setSavingKey(null)
  }

  const hiddenCount = SWITCHES.filter(s => !prefs[s.key]).length

  return (
    <section className="bg-ow-panel rounded-xl p-6 border border-ow-line space-y-4">
      <div>
        <h2 className="font-display text-lg tracking-wider text-ow-fg uppercase">Excluded games</h2>
        <p className="text-xs text-ow-faint mt-1">
          Games that distort your stats, hidden from win rate, Outcomes, Combat, Time,
          Heroes and Matchups. Feel and the Builder always include them — those pages
          exist to analyse them.
        </p>
      </div>

      <div className="space-y-2">
        {SWITCHES.map(s => {
          const on = prefs[s.key]
          return (
            <div key={s.key} className="bg-ow-dark/60 rounded-lg p-3 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-display text-sm text-ow-fg tracking-wider">{s.label}</p>
                <p className="text-xs text-ow-faint mt-1">{s.detail}</p>
                <p className="text-[11px] font-display tracking-wider uppercase mt-1.5">
                  {!loaded
                    ? <span className="text-ow-faint">Loading…</span>
                    : on
                      ? <span className="text-ow-orange">Shown</span>
                      : <span className="text-ow-faint">Hidden</span>}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`Show ${s.label.toLowerCase()} in analytics`}
                disabled={!loaded || savingKey === s.key}
                onClick={() => toggle(s.key)}
                className={`relative shrink-0 mt-0.5 w-14 h-8 rounded-full transition-colors disabled:opacity-50
                  ${on ? 'bg-ow-orange' : 'bg-ow-dark border border-ow-line'}`}
              >
                <span
                  className={`absolute top-1 left-1 w-6 h-6 rounded-full bg-white transition-transform
                    ${on ? 'translate-x-6' : 'translate-x-0'}`}
                />
              </button>
            </div>
          )
        })}
      </div>

      {loaded && (
        <p className="text-[11px] text-ow-faint">
          {hiddenCount === 0
            ? 'Every game is included — your stats show all matches exactly as played.'
            : `${hiddenCount} of 3 categories hidden. A match is only shown if every reason it carries is switched on, so a thrown game with a leaver stays hidden until both are.`}
        </p>
      )}
    </section>
  )
}
