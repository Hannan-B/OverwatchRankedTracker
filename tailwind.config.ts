import type { Config } from 'tailwindcss'

// ============================================================
// THEME TOKENS — variable-backed (NEXT-STEPS #16)
// ------------------------------------------------------------
// The ow-* colours are defined as `rgb(var(--ow-*) / <alpha-value>)` instead of
// hardcoded hex. The CSS variables hold SPACE-SEPARATED RGB CHANNELS (e.g.
// "10 22 40"), set per theme under [data-theme="dark"|"light"] in globals.css.
//
// Why channels + <alpha-value>: it preserves Tailwind's opacity modifiers. With
// this form, `bg-ow-dark` compiles to `rgb(var(--ow-dark) / 1)` and
// `bg-ow-panel/80` to `rgb(var(--ow-panel) / 0.8)` — so all existing usages
// (incl. the ~151 opacity-suffixed ones) keep working untouched, and flipping
// data-theme re-themes the whole app with no per-component edits.
//
// `fg` is the body/default text colour (was a hardcoded #e2e8f0 on body); it's
// now themed too, so light mode gets dark text automatically.
// ============================================================

const owColor = (name: string) => `rgb(var(--ow-${name}) / <alpha-value>)`

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        ow: {
          blue: owColor('blue'),
          orange: owColor('orange'),
          dark: owColor('dark'),
          panel: owColor('panel'),
          accent: owColor('accent'),
          victory: owColor('victory'),
          defeat: owColor('defeat'),
          draw: owColor('draw'),
          fg: owColor('fg'),
          // Theme-aware text + border tokens (NEXT-STEPS #16). Use these instead
          // of hardcoded text-slate-* / border-white/* so they flip per theme.
          muted: owColor('muted'),
          faint: owColor('faint'),
          line: owColor('line'),
        },
      },
      fontFamily: {
        display: ['var(--font-display)'],
        body: ['var(--font-body)'],
      },
    },
  },
  plugins: [],
}
export default config
