import { redirect } from 'next/navigation'

// ============================================================
// /compare → /analytics/hero_compare  (permanent move, #12)
// The Hero Compare page moved into the Analytics area. This stub keeps old
// links/bookmarks working by redirecting to the new route. Server component
// (no 'use client') so the redirect happens before any render.
// ============================================================

export default function CompareRedirect() {
  redirect('/analytics/hero_compare')
}
