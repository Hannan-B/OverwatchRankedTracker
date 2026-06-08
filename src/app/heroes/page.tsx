import { redirect } from 'next/navigation'

// The hero list page moved into the Analytics area. Keep this path alive so old
// links/bookmarks (and any internal links not yet updated) don't break.
export default function HeroesRedirect() {
  redirect('/analytics/heroes')
}
