import { supabase } from '@/lib/supabase'

// ============================================================
// THEME PREFERENCE — single source of truth (NEXT-STEPS #16)
// ============================================================
//
// Three modes: 'system' (follow prefers-color-scheme), 'light', 'dark'. The mode
// is a real user preference that should follow you across devices, so — like the
// leaver pref — it lives in user_settings.theme_mode (NOT localStorage).
//
// RESOLUTION: the stored MODE resolves to an applied THEME ('light' | 'dark').
//   • light/dark  → that theme, ignoring the OS.
//   • system      → whatever prefers-color-scheme reports right now (re-resolved
//                   live when the OS theme changes, see watchSystemTheme()).
// applyTheme() writes data-theme on <html>; globals.css does the rest.
//
// NO-FOUC: the very first paint can't wait for a DB read, so layout.tsx runs a
// tiny inline script that sets data-theme from prefers-color-scheme synchronously.
// Then loadThemePref() resolves the stored mode and reconciles (usually a no-op
// when the stored mode is 'system' and matches the OS; a visible correction only
// when the user has forced light/dark against their OS default).
//
// Mirrors leaver.ts: load once into a module cache, read sync thereafter.

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const DEFAULT_MODE: ThemeMode = 'system'

// Module-level cache.
let cachedMode: ThemeMode = DEFAULT_MODE
let loaded = false

/** Does the OS currently prefer dark? (false during SSR — safe, reconciled client-side.) */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true // default dark
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Resolve a mode to the concrete theme to apply. */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode
  return systemPrefersDark() ? 'dark' : 'light'
}

/** Write the resolved theme onto <html data-theme>. No-op during SSR. */
export function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', theme)
}

/** Current mode from the cache (sync). Defaults to 'system' until loaded. */
export function themeMode(): ThemeMode {
  return cachedMode
}

/** Has the preference been loaded from the DB yet this session? */
export function themePrefLoaded(): boolean {
  return loaded
}

/**
 * Load theme_mode from user_settings into the cache, then apply it. Call once on
 * app load (top-level effect). Never throws; on any error the cache stays at the
 * safe default ('system'). Returns the resolved theme that was applied.
 */
export async function loadThemePref(): Promise<ResolvedTheme> {
  try {
    const { data } = await supabase
      .from('user_settings')
      .select('theme_mode')
      .limit(1)
      .single()
    const m = (data as { theme_mode?: string | null } | null)?.theme_mode
    cachedMode = (m === 'light' || m === 'dark' || m === 'system') ? m : DEFAULT_MODE
  } catch {
    cachedMode = DEFAULT_MODE
  }
  loaded = true
  const resolved = resolveTheme(cachedMode)
  applyTheme(resolved)
  return resolved
}

/**
 * Set the mode: apply immediately, update the cache, and persist to user_settings
 * (upserting the single row). Returns the resolved theme now in effect.
 */
export async function setThemeMode(next: ThemeMode): Promise<ResolvedTheme> {
  cachedMode = next
  loaded = true
  const resolved = resolveTheme(next)
  applyTheme(resolved)
  try {
    const { data: existing } = await supabase
      .from('user_settings')
      .select('id')
      .limit(1)
      .single()
    if (existing) {
      await supabase
        .from('user_settings')
        .update({ theme_mode: next })
        .eq('id', (existing as { id: number }).id)
    } else {
      await supabase
        .from('user_settings')
        .insert({ theme_mode: next })
    }
  } catch {
    /* keep the cache value even if the write fails; it re-syncs next load */
  }
  return resolved
}

/**
 * While the mode is 'system', keep the applied theme in sync with live OS changes.
 * Returns an unsubscribe fn. No-op off-browser. Call from a top-level effect.
 */
export function watchSystemTheme(): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => {
    if (cachedMode === 'system') applyTheme(systemPrefersDark() ? 'dark' : 'light')
  }
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}
