'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// ============================================================
// ANALYTICS NAV + HEADER — shared chrome for the /analytics area
// ------------------------------------------------------------
// ONE source of truth (ANALYTICS_GROUPS below) for the surfaces, their order,
// labels, and grouping — consumed by the sub-nav, the /analytics overview, and
// the Home block, so they can never drift.
//
// Three groups (display order):
//   1. Match analysis — Outcomes · Feel · Time · Combat
//   2. Hero analysis  — Heroes · Hero Pairings · Hero Matchups
//   3. Build your own — Builder (the generic laboratory, alone, shown last)
// The flat sub-nav (ANALYTICS_TABS) is derived by flattening the groups.
// ============================================================

export interface AnalyticsTab {
  href: string
  label: string
  blurb?: string          // shown on the overview cards + Home block
  kind?: 'curated' | 'builder'
}

export interface AnalyticsGroup {
  label: string           // section heading
  tabs: AnalyticsTab[]
}

// THE source of truth for the analytics surfaces, in three groups:
//   1. Match-level views   2. Hero views   3. The generic Builder (alone)
// Both the top sub-nav, the /analytics overview, and the Home block render from
// this — so order/labels/grouping can never drift between them.
//
// ⚠️ (v1.1.0 Phase 6) BLURBS MUST NOT NAME A SPECIFIC FEEL FIELD BY VERSION.
// The Feel blurb used to advertise "tilt" and "tempo" — version-1 questions
// retired in this patch — so the menu promised two charts the page would stop
// drawing the moment a version-2 season began. It is now worded from what the
// page ASKS ABOUT (fun, the matchup, your own performance), which is true on
// both scales. `seasons.question_scale_version` decides which columns render;
// this list has no access to that and must never imply it does.
export const ANALYTICS_GROUPS: AnalyticsGroup[] = [
  {
    label: 'Match analysis',
    tabs: [
      { href: '/analytics/outcomes', label: 'Outcomes', kind: 'curated', blurb: 'Win rate by mode, map, and role, with 5v5 vs 6v6 and your result mix.' },
      { href: '/analytics/feel', label: 'Feel', kind: 'curated', blurb: 'How fun, matchup feel, and your own performance ratings line up against your results.' },
      { href: '/analytics/time', label: 'Time', kind: 'curated', blurb: 'Streaks, sessions, time-of-day, and game-length patterns.' },
      { href: '/analytics/combat', label: 'Combat', kind: 'curated', blurb: 'Damage/healing share, E/A/D trends, and how stats differ in wins vs losses.' },
    ],
  },
  {
    label: 'Hero analysis',
    tabs: [
      { href: '/analytics/heroes', label: 'Heroes', kind: 'curated', blurb: 'Each hero\u2019s win rate, record, and per-game stats \u2014 filterable by mode, map, and season.' },
      { href: '/analytics/hero_compare', label: 'Hero Compare', kind: 'curated', blurb: 'Put up to four heroes (or one hero across different conditions) side by side.' },
      { href: '/analytics/heroes-overview', label: 'Hero Pairings', kind: 'curated', blurb: 'Which heroes you pair together, and how those combinations perform.' },
      { href: '/analytics/matchups', label: 'Hero Matchups', kind: 'curated', blurb: 'Pick a hero to see its strongest and weakest enemy matchups and ally pairings.' },
    ],
  },
  {
    label: 'Build your own',
    tabs: [
      { href: '/analytics/builder', label: 'Builder', kind: 'builder', blurb: 'Build any chart yourself \u2014 pick a variable, a measure, and a chart type.' },
    ],
  },
]

// Flat tab list (sub-nav order = group order, flattened). Derived, so it stays
// in lockstep with the groups above.
export const ANALYTICS_TABS: AnalyticsTab[] = ANALYTICS_GROUPS.flatMap(g => g.tabs)


export function AnalyticsNav() {
  const pathname = usePathname()
  return (
    <nav className="flex flex-wrap gap-1 border-b border-ow-line pb-px">
      <Link
        href="/analytics"
        className={`px-3 py-2 text-xs font-display tracking-wider uppercase rounded-t-md transition-colors ${
          pathname === '/analytics'
            ? 'text-ow-orange border-b-2 border-ow-orange'
            : 'text-ow-muted hover:text-ow-fg'
        }`}>
        Overview
      </Link>
      {ANALYTICS_TABS.map(t => {
        const active = pathname === t.href || pathname.startsWith(t.href + '/')
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`px-3 py-2 text-xs font-display tracking-wider uppercase rounded-t-md transition-colors ${
              active
                ? 'text-ow-orange border-b-2 border-ow-orange'
                : 'text-ow-muted hover:text-ow-fg'
            }`}>
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}

export function AnalyticsHeader({
  title,
  subtitle,
}: {
  title: string
  subtitle?: string
}) {
  return (
    <div>
      <h1 className="font-display text-3xl tracking-[0.12em] text-ow-fg uppercase">
        {title}
      </h1>
      {subtitle && <p className="text-sm text-ow-muted mt-1">{subtitle}</p>}
    </div>
  )
}

// ============================================================
// AnalyticsMenu — the grouped surface cards, rendered from ANALYTICS_GROUPS.
// Used by the /analytics overview AND the Home page (so they stay identical).
// `compact` tightens it for the Home block (smaller headings, denser cards).
// ============================================================
export function AnalyticsMenu({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'space-y-5' : 'space-y-7'}>
      {ANALYTICS_GROUPS.map(group => (
        <div key={group.label} className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="h-1 w-8 bg-ow-orange rounded-full" />
            <h3 className="font-display tracking-[0.15em] text-ow-muted uppercase text-xs">
              {group.label}
            </h3>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 items-start">
            {group.tabs.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className="block bg-ow-panel rounded-lg p-4 border border-ow-line
                           hover:border-ow-orange/40 transition-colors">
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-display font-bold text-ow-fg tracking-wider uppercase ${compact ? 'text-base' : 'text-lg'}`}>
                    {item.label}
                  </span>
                </div>
                {item.blurb && <p className="text-sm text-ow-muted mt-1.5">{item.blurb}</p>}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
