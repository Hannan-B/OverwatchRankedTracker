'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { RoleType } from '@/lib/types'

export default function SettingsPage() {
  const [gamertag, setGamertag] = useState('')
  const [defaultRole, setDefaultRole] = useState<RoleType | ''>('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('user_settings')
        .select('*')
        .limit(1)
        .single()
      if (data) {
        setGamertag(data.gamertag || '')
        setDefaultRole(data.default_role || '')
      }
    }
    load()
  }, [])

  async function handleSave() {
    setSaving(true)
    setSaved(false)

    // Check if settings row exists
    const { data: existing } = await supabase
      .from('user_settings')
      .select('id')
      .limit(1)
      .single()

    if (existing) {
      await supabase
        .from('user_settings')
        .update({
          gamertag: gamertag || null,
          default_role: defaultRole || null,
        })
        .eq('id', existing.id)
    } else {
      await supabase
        .from('user_settings')
        .insert({
          gamertag: gamertag || null,
          default_role: defaultRole || null,
        })
    }

    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="space-y-6 max-w-lg mx-auto">
      <div>
        <h1 className="text-3xl text-ow-orange">Settings</h1>
        <p className="text-sm text-slate-400 mt-1">App preferences</p>
      </div>

      <div className="bg-ow-panel rounded-lg p-6 border border-white/5 space-y-5">
        {/* Gamertag */}
        <div>
          <label className="block text-sm font-display tracking-wider text-slate-300 mb-2">
            GAMERTAG
          </label>
          <input
            type="text"
            value={gamertag}
            onChange={e => setGamertag(e.target.value)}
            placeholder="Your in-game name"
            className="w-full bg-ow-dark border border-white/10 rounded-lg px-4 py-2.5
                       text-white placeholder-slate-600 focus:border-ow-orange/50
                       focus:outline-none transition-colors"
          />
          <p className="text-xs text-slate-600 mt-1">
            Used for Stage 2 scoreboard identification
          </p>
        </div>

        {/* Default role */}
        <div>
          <label className="block text-sm font-display tracking-wider text-slate-300 mb-2">
            DEFAULT ROLE
          </label>
          <div className="flex gap-2">
            {(['tank', 'dps', 'support'] as const).map(role => (
              <button
                key={role}
                onClick={() => setDefaultRole(role)}
                className={`flex-1 py-2 rounded-lg text-sm font-display tracking-wider
                           transition-colors
                  ${defaultRole === role
                    ? 'bg-ow-orange text-ow-dark font-bold'
                    : 'bg-ow-dark text-slate-400 border border-white/10 hover:text-white'
                  }`}
              >
                {role.toUpperCase()}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-600 mt-1">
            Pre-selects your role when logging a new match
          </p>
        </div>

        {/* Save button */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full bg-ow-orange hover:bg-ow-accent disabled:bg-slate-700
                     text-ow-dark font-display font-bold py-2.5 rounded-lg
                     tracking-wider transition-colors text-sm"
        >
          {saving ? 'SAVING...' : saved ? '✓ SAVED' : 'SAVE SETTINGS'}
        </button>
      </div>

      {/* Season management */}
      <div className="bg-ow-panel rounded-lg p-6 border border-white/5">
        <h2 className="text-lg font-display text-white mb-3">Seasons</h2>
        <p className="text-sm text-slate-400">
          Season management coming soon. Matches will auto-assign to the correct
          competitive season based on their date.
        </p>
      </div>
    </div>
  )
}
