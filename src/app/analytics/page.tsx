'use client'

import { AnalyticsNav, AnalyticsHeader, AnalyticsMenu, ANALYTICS_TABS } from '@/components/AnalyticsNav'

// ============================================================
// ANALYTICS LANDING — the "front" of the Analytics area
// ------------------------------------------------------------
// A grouped menu of every surface, rendered from the shared ANALYTICS_GROUPS
// (via AnalyticsMenu) so the overview, the sub-nav, and the Home block all stay
// in lockstep. Three groups: Match analysis · Hero analysis · Build your own.
// ============================================================

export default function AnalyticsLandingPage() {
  return (
    <div className="space-y-6">
      <AnalyticsHeader
        title="Analytics"
        subtitle="Curated views plus a generic builder. Pick a surface to explore."
      />
      <AnalyticsNav />

      <AnalyticsMenu />

      <p className="text-xs text-slate-500">
        {ANALYTICS_TABS.length} surfaces, grouped above. Curated pages are the
        designed views; the Builder is the generic laboratory.
      </p>
    </div>
  )
}
