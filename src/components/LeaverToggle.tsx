'use client'

import { useEffect, useState } from 'react'
import { loadLeaverPref, setShowLeaverGames } from '@/lib/leaver'

// ============================================================
// LEAVER-GAME VISIBILITY TOGGLE (Settings)
// ------------------------------------------------------------
// Controls whether leaver games are included on the PERFORMANCE surfaces
// (Outcomes, Combat, Time, Heroes, Matchups, Pairings). Default OFF (hidden).
//
// Unlike the alpha toggle, this is a real user preference that applies on LIVE
// too and follows you across devices — it's stored in user_settings, not
// localStorage. Reads/writes go through @/lib/leaver (which caches the value so
// the analytics read-side can stay synchronous).
//
// Feel and the Builder always show leaver games regardless of this switch — they
// analyse leaver games on purpose — as do the overview leaver count boxes.
// ============================================================

export default function LeaverToggle() {
  const [on, setOn] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    loadLeaverPref().then(v => {
      if (active) { setOn(v); setLoaded(true) }
    })
    return () => { active = false }
  }, [])

  async function toggle() {
    const next = !on
    setOn(next)          // optimistic — the cache is updated inside setShowLeaverGames too
    setSaving(true)
    await setShowLeaverGames(next)
    setSaving(false)
  }

  return (
    <section className="bg-ow-panel rounded-xl p-6 border border-ow-line space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-lg tracking-wider text-ow-fg uppercase">Leaver games</h2>
          <p className="text-xs text-ow-faint mt-1">
            Games you tagged with a leaver can&apos;t have their scoreboard read, so
            they distort your stats. They&apos;re hidden from win rate, Combat, Time,
            Heroes and Matchups by default. Feel and the Builder always include them.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Show leaver games in analytics"
          disabled={!loaded || saving}
          onClick={toggle}
          className={`relative shrink-0 w-14 h-8 rounded-full transition-colors disabled:opacity-50
            ${on ? 'bg-ow-orange' : 'bg-ow-dark border border-ow-line'}`}
        >
          <span
            className={`absolute top-1 left-1 w-6 h-6 rounded-full bg-white transition-transform
              ${on ? 'translate-x-6' : 'translate-x-0'}`}
          />
        </button>
      </div>
      <p className="text-xs font-display tracking-wider uppercase">
        {!loaded
          ? <span className="text-ow-faint">Loading…</span>
          : on
            ? <span className="text-ow-orange">Showing leaver games</span>
            : <span className="text-ow-faint">Leaver games hidden</span>}
      </p>
    </section>
  )
}
