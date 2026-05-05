import type { Config } from 'tailwindcss'

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
          blue: '#1e3a5f',
          orange: '#f99e1a',
          dark: '#0a1628',
          panel: '#132038',
          accent: '#ff6b35',
          victory: '#4ade80',
          defeat: '#f87171',
          draw: '#fbbf24',
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
