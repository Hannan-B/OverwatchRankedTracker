'use client'

import { useState, useRef } from 'react'
import { ocrBreakdownPage, terminateBreakdownOcr, type BreakdownStat } from '@/lib/breakdown-ocr'
import { HERO_STAT_LOOKUP } from '@/data/hero-stat-catalog'
import { HEROES } from '@/data/reference'

// ============================================================
// FILENAME → HERO NAME MAPPING
// ============================================================

const FILENAME_TO_HERO: Record<string, string> = {
  'Ana': 'Ana',
  'Anran': 'Anran',
  'Ashe': 'Ashe',
  'Baptiste': 'Baptiste',
  'Bastion': 'Bastion',
  'Brigitte': 'Brigitte',
  'Cassidy': 'Cassidy',
  'D_Va': 'D.Va',
  'D.Va': 'D.Va',
  'DVa': 'D.Va',
  'Domina': 'Domina',
  'Doomfist': 'Doomfist',
  'Echo': 'Echo',
  'Emre': 'Emre',
  'Freja': 'Freja',
  'Genji': 'Genji',
  'Hanzo': 'Hanzo',
  'Hazard': 'Hazard',
  'Illari': 'Illari',
  'Jetpack_Cat': 'Jetpack Cat',
  'Jetpack Cat': 'Jetpack Cat',
  'Junker_Queen': 'Junker Queen',
  'Junker Queen': 'Junker Queen',
  'Junkrat': 'Junkrat',
  'Juno': 'Juno',
  'Kiriko': 'Kiriko',
  'Lifeweaver': 'Lifeweaver',
  'Lúcio': 'Lúcio',
  'Lucio': 'Lúcio',
  'Mauga': 'Mauga',
  'Mei': 'Mei',
  'Mercy': 'Mercy',
  'Mizuki': 'Mizuki',
  'Moira': 'Moira',
  'Orisa': 'Orisa',
  'Pharah': 'Pharah',
  'Ramattra': 'Ramattra',
  'Reaper': 'Reaper',
  'Reinhardt': 'Reinhardt',
  'Roadhog': 'Roadhog',
  'Sierra': 'Sierra',
  'Sigma': 'Sigma',
  'Sojourn': 'Sojourn',
  'Soldier_76': 'Soldier: 76',
  'Soldier 76': 'Soldier: 76',
  'Sombra': 'Sombra',
  'Symmetra': 'Symmetra',
  'Torbjörn': 'Torbjörn',
  'Torbjorn': 'Torbjörn',
  'Tracer': 'Tracer',
  'Vendetta': 'Vendetta',
  'Venture': 'Venture',
  'Widowmaker': 'Widowmaker',
  'Winston': 'Winston',
  'Wrecking_Ball': 'Wrecking Ball',
  'Wrecking Ball': 'Wrecking Ball',
  'Wuyang': 'Wuyang',
  'Zarya': 'Zarya',
  'Zenyatta': 'Zenyatta',
}

function heroFromFilename(filename: string): string | null {
  const base = filename
    .replace(/\.(jpg|jpeg|png|webp)$/i, '')
    .replace(/[\s_]?Hero[\s_]?Breakdown/i, '')
    .trim()

  const withUnderscores = base.replace(/\s+/g, '_')
  const withSpaces = base.replace(/_/g, ' ')
  const stripped = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

  if (FILENAME_TO_HERO[base]) return FILENAME_TO_HERO[base]
  if (FILENAME_TO_HERO[withUnderscores]) return FILENAME_TO_HERO[withUnderscores]
  if (FILENAME_TO_HERO[withSpaces]) return FILENAME_TO_HERO[withSpaces]
  if (FILENAME_TO_HERO[stripped]) return FILENAME_TO_HERO[stripped]

  for (const hero of HEROES) {
    const heroNorm = hero.name.normalize('NFC')
    const heroStripped = hero.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    if (base.toLowerCase() === heroNorm.toLowerCase()) return hero.name
    if (withSpaces.toLowerCase() === heroNorm.toLowerCase()) return hero.name
    if (stripped.toLowerCase() === heroStripped.toLowerCase()) return hero.name
  }

  return null
}

// ============================================================
// TYPES
// ============================================================

interface HeroResult {
  heroName: string
  filename: string
  percentPlayed: number | null
  playTimeSeconds: number | null
  expectedStats: string[]
  foundStats: Array<{
    statName: string
    found: boolean
    value: string | null
    avgPer10: string | null
  }>
  accuracy: number
  raw: string
}

// ============================================================
// TEST PAGE
// ============================================================

export default function TestBreakdownsPage() {
  const [results, setResults] = useState<HeroResult[]>([])
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState('')
  const [batchNum, setBatchNum] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return

    setProcessing(true)
    setError(null)
    setResults([])

    const heroResults: HeroResult[] = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const heroName = heroFromFilename(file.name)

      if (!heroName) {
        setError(`Could not determine hero from filename "${file.name}"`)
        setProcessing(false)
        return
      }

      setProgress(`Processing ${i + 1}/${files.length}: ${heroName}...`)

      try {
        // Load image
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image()
          el.onload = () => resolve(el)
          el.onerror = reject
          el.src = URL.createObjectURL(file)
        })

        // Run OCR
        const ocrResult = await ocrBreakdownPage(img, heroName)

        // Compare against catalog
        const catalogEntry = HERO_STAT_LOOKUP.get(heroName)
        const expectedStats = catalogEntry ? catalogEntry.stats.map(s => s.name) : []

        const foundStats = expectedStats.map(statName => {
          const match = ocrResult.stats.find(
            s => s.statName.toUpperCase() === statName.toUpperCase()
          )
          return {
            statName,
            found: !!match,
            value: match?.statValue || null,
            avgPer10: match?.avgPer10Min || null,
          }
        })

        const foundCount = foundStats.filter(s => s.found).length
        const accuracy = expectedStats.length > 0
          ? Math.round((foundCount / expectedStats.length) * 100)
          : 100

        heroResults.push({
          heroName,
          filename: file.name,
          percentPlayed: ocrResult.percentPlayed,
          playTimeSeconds: ocrResult.playTimeSeconds,
          expectedStats,
          foundStats,
          accuracy,
          raw: ocrResult.raw,
        })

        URL.revokeObjectURL(img.src)
      } catch (err) {
        console.error(`Error processing ${file.name}:`, err)
        heroResults.push({
          heroName,
          filename: file.name,
          percentPlayed: null,
          playTimeSeconds: null,
          expectedStats: [],
          foundStats: [],
          accuracy: 0,
          raw: `ERROR: ${err}`,
        })
      }
    }

    await terminateBreakdownOcr()
    setResults(heroResults)
    setProcessing(false)
    setProgress('')

    if (fileRef.current) fileRef.current.value = ''
  }

  function generateReport(): string {
    const totalExpected = results.reduce((s, r) => s + r.expectedStats.length, 0)
    const totalFound = results.reduce((s, r) => s + r.foundStats.filter(f => f.found).length, 0)
    const perfect = results.filter(r => r.accuracy === 100).length
    const heroInfoFound = results.filter(r => r.percentPlayed !== null && r.playTimeSeconds !== null).length

    let md = `# Breakdown OCR v13 — Test Report (Batch ${batchNum})\n\n`
    md += `**Engine:** Template Matching (NCC + Smart Segmentation)\n`
    md += `**Date:** ${new Date().toISOString().split('T')[0]}\n\n`
    md += `## Summary\n\n`
    md += `| Metric | Value |\n|--------|-------|\n`
    md += `| Heroes tested | ${results.length} |\n`
    md += `| Total stats expected | ${totalExpected} |\n`
    md += `| Total stats found | ${totalFound} |\n`
    md += `| Overall accuracy | ${totalExpected > 0 ? ((totalFound / totalExpected) * 100).toFixed(1) : 0}% |\n`
    md += `| Perfect heroes (100%) | ${perfect}/${results.length} |\n`
    md += `| Hero info found (% + time) | ${heroInfoFound}/${results.length} |\n\n`

    md += `## Per-Hero Results\n\n`
    md += `| Hero | Expected | Found | Accuracy | % Played | Play Time |\n`
    md += `|------|----------|-------|----------|----------|----------|\n`

    for (const r of results.sort((a, b) => a.heroName.localeCompare(b.heroName))) {
      const found = r.foundStats.filter(f => f.found).length
      const time = r.playTimeSeconds !== null
        ? `${Math.floor(r.playTimeSeconds / 60).toString().padStart(2, '0')}:${(r.playTimeSeconds % 60).toString().padStart(2, '0')}`
        : 'NOT FOUND'
      md += `| ${r.heroName} | ${r.expectedStats.length} | ${found} | ${r.accuracy}% | ${r.percentPlayed !== null ? r.percentPlayed + '%' : 'NOT FOUND'} | ${time} |\n`
    }

    md += `\n## Detailed Breakdown\n\n`

    for (const r of results.sort((a, b) => a.heroName.localeCompare(b.heroName))) {
      md += `### ${r.heroName}\n\n`
      md += `- **File:** ${r.filename}\n`
      md += `- **Percent Played:** ${r.percentPlayed !== null ? r.percentPlayed + '%' : 'NOT FOUND'}\n`
      md += `- **Play Time:** ${r.playTimeSeconds !== null ? `${Math.floor(r.playTimeSeconds / 60)}:${(r.playTimeSeconds % 60).toString().padStart(2, '0')}` : 'NOT FOUND'}\n\n`

      if (r.foundStats.length > 0) {
        md += `| Status | Stat Name | Value | Avg/10 |\n`
        md += `|--------|-----------|-------|--------|\n`
        for (const s of r.foundStats) {
          md += `| ${s.found ? '✅' : '❌'} | ${s.statName} | ${s.value || '—'} | ${s.avgPer10 || '—'} |\n`
        }
        md += '\n'
      }
    }

    return md
  }

  function downloadReport() {
    const md = generateReport()
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `breakdown-test-v13-batch-${batchNum}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Summary stats
  const totalExpected = results.reduce((s, r) => s + r.expectedStats.length, 0)
  const totalFound = results.reduce((s, r) => s + r.foundStats.filter(f => f.found).length, 0)
  const perfect = results.filter(r => r.accuracy === 100).length
  const heroInfoFound = results.filter(r => r.percentPlayed !== null && r.playTimeSeconds !== null).length

  return (
    <div className="min-h-screen bg-slate-950 text-white p-6">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">Breakdown OCR v13 — Template Matching Test</h1>
        <p className="text-sm text-slate-400 mb-6">
          Engine: NCC Template Matching · Replaces Tesseract for value extraction · Python reference: 365/365 (100%)
        </p>

        {/* Upload area */}
        <div className="border border-dashed border-slate-700 rounded-lg p-6 mb-6 text-center">
          <p className="text-sm text-slate-400 mb-3">
            Batch {batchNum} — Upload up to 20 hero breakdown screenshots
          </p>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*"
            onChange={handleFiles}
            disabled={processing}
            className="text-sm"
          />
        </div>

        {/* Progress */}
        {processing && (
          <div className="bg-blue-900/30 border border-blue-500/30 rounded-lg p-4 mb-6">
            <p className="text-sm text-blue-300">{progress}</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-900/30 border border-red-500/30 rounded-lg p-4 mb-6">
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        {/* Results dashboard */}
        {results.length > 0 && (
          <>
            {/* Summary bar */}
            <div className="grid grid-cols-4 gap-3 mb-6">
              <div className="bg-slate-900 rounded-lg p-4 text-center">
                <p className="text-2xl font-bold">{results.length}</p>
                <p className="text-xs text-slate-400">Heroes</p>
              </div>
              <div className="bg-slate-900 rounded-lg p-4 text-center">
                <p className={`text-2xl font-bold ${totalFound === totalExpected ? 'text-green-400' : 'text-orange-400'}`}>
                  {totalFound}/{totalExpected}
                </p>
                <p className="text-xs text-slate-400">Stats Found</p>
              </div>
              <div className="bg-slate-900 rounded-lg p-4 text-center">
                <p className={`text-2xl font-bold ${perfect === results.length ? 'text-green-400' : 'text-orange-400'}`}>
                  {perfect}/{results.length}
                </p>
                <p className="text-xs text-slate-400">Perfect (100%)</p>
              </div>
              <div className="bg-slate-900 rounded-lg p-4 text-center">
                <p className={`text-2xl font-bold ${heroInfoFound === results.length ? 'text-green-400' : 'text-orange-400'}`}>
                  {heroInfoFound}/{results.length}
                </p>
                <p className="text-xs text-slate-400">Hero Info Found</p>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex gap-3 mb-6">
              <button
                onClick={downloadReport}
                className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg font-medium"
              >
                DOWNLOAD REPORT
              </button>
              <button
                onClick={() => { setBatchNum(b => b + 1); setResults([]) }}
                className="bg-slate-700 hover:bg-slate-600 text-white text-sm px-4 py-2 rounded-lg font-medium"
              >
                TEST NEXT BATCH
              </button>
            </div>

            {/* Per-hero results */}
            {results.map((r, i) => (
              <div key={i} className="bg-slate-900 rounded-lg p-4 mb-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className="font-bold text-lg">{r.heroName}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      r.accuracy === 100
                        ? 'bg-green-900/50 text-green-300'
                        : r.accuracy >= 80
                        ? 'bg-orange-900/50 text-orange-300'
                        : 'bg-red-900/50 text-red-300'
                    }`}>
                      {r.foundStats.filter(f => f.found).length}/{r.expectedStats.length} stats · {r.accuracy}%
                    </span>
                  </div>
                  <div className="flex gap-4 text-xs text-slate-400">
                    <span>
                      % Played: {r.percentPlayed !== null
                        ? <span className="text-green-300">{r.percentPlayed}%</span>
                        : <span className="text-red-400">NOT FOUND</span>}
                    </span>
                    <span>
                      Play Time: {r.playTimeSeconds !== null
                        ? <span className="text-green-300">
                            {Math.floor(r.playTimeSeconds / 60).toString().padStart(2, '0')}:
                            {(r.playTimeSeconds % 60).toString().padStart(2, '0')}
                          </span>
                        : <span className="text-red-400">NOT FOUND</span>}
                    </span>
                  </div>
                </div>

                {/* Stat tiles */}
                <div className="grid grid-cols-4 gap-2">
                  {r.foundStats.map((stat, j) => (
                    <div key={j} className={`border rounded px-2 py-1.5 ${
                      stat.found
                        ? 'bg-slate-800 border-green-800/40'
                        : 'bg-slate-800/40 border-red-800/40'
                    }`}>
                      <div className="flex items-center gap-1">
                        <span className="text-xs">{stat.found ? '✅' : '❌'}</span>
                        <span className={`text-sm font-bold ${stat.found ? 'text-white' : 'text-slate-600'}`}>
                          {stat.found ? stat.value : '—'}
                        </span>
                      </div>
                      <p className={`text-xs leading-tight truncate ${stat.found ? 'text-slate-400' : 'text-slate-600'}`}>
                        {stat.statName}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
