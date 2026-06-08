import { redirect } from 'next/navigation'

// The hero detail page moved under the Analytics area. Preserve the hero name
// in the redirect so old links to a specific hero still land correctly.
export default async function HeroDetailRedirect({
  params,
}: {
  params: Promise<{ name: string }>
}) {
  const { name } = await params
  redirect(`/analytics/heroes/${name}`)
}
