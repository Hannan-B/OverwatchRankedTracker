'use client'

import { useState, useRef, useCallback } from 'react'
import type {
  ScoreboardDetectionResult,
  ScoreboardHeroIdentification,
  ScoreboardPlayerLabel,
  ScoreboardOcrAnalysis,
  ScoreboardRoleClassification,
  ScoreboardPlayerStats,
} from '@/lib/types'
import {
  detectScoreboard,
  classifyRoles,
  identifyHeroes,
  analyzeUserIdentity,
  buildPlayerLabels,
  extractStats,
} from '@/lib/scoreboard-extractor'

// ============================================================
// TEST-PAGE-SPECIFIC TYPES
// ============================================================

/** Combined result for one image */
interface ScoreboardTestResult {
  id: number
  filename: string
  timestamp: string
  imageDimensions: { width: number; height: number }
  imageDataUrl: string | null
  detection: ScoreboardDetectionResult
  heroes: ScoreboardHeroIdentification[]
  players: ScoreboardPlayerLabel[]
  roles: ScoreboardRoleClassification[]
  stats: ScoreboardPlayerStats[]
  ocrAnalysis: ScoreboardOcrAnalysis | null
}

// ============================================================
// REPORT GENERATION
// ============================================================

function generateReport(
  testNumber: number,
  results: ScoreboardTestResult[]
): string {
  const date = new Date().toISOString().split('T')[0]
  const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

  let md = `# Scoreboard Extraction — Test Report #${testNumber}\n\n`
  md += `**Date:** ${date} ${time}\n`
  md += `**Images tested:** ${results.length}\n\n`
  md += `---\n\n`

  for (const r of results) {
    md += `## Image: ${r.filename}\n\n`
    md += `- **Processed at:** ${r.timestamp}\n`
    md += `- **Dimensions:** ${r.imageDimensions.width} × ${r.imageDimensions.height}\n\n`

    // Section 1: Detection
    md += `### 1. Detection\n\n`
    md += `| Field | Value |\n|-------|-------|\n`
    md += `| Type detected | ${r.detection.imageType} |\n`
    md += `| Confidence | ${(r.detection.confidence * 100).toFixed(1)}% |\n`
    md += `| Signals | ${r.detection.signals.length > 0 ? r.detection.signals.join('; ') : 'None'} |\n\n`

    if (r.detection.grid) {
      const g = r.detection.grid
      md += `**Grid Mapping:**\n\n`
      md += `| Section | Y Range | Row Height |\n|---------|---------|------------|\n`
      md += `| Ally | ${g.ally.startY}–${g.ally.endY} | ~${g.ally.rowHeight.toFixed(0)}px |\n`
      md += `| Enemy | ${g.enemy.startY}–${g.enemy.endY} | ~${g.enemy.rowHeight.toFixed(0)}px |\n\n`
      md += `| Slot | Team | Top Y | Center Y | Bottom Y |\n`
      md += `|------|------|-------|----------|----------|\n`
      for (const row of g.rows) {
        md += `| ${row.slot} | ${row.team} | ${row.topY} | ${row.centerY} | ${row.bottomY} |\n`
      }
      md += `\n`
    }

    if (r.detection.imageType !== 'scoreboard') {
      md += `> ⚠️ Not classified as scoreboard — remaining sections skipped.\n\n`
      md += `---\n\n`
      continue
    }

    // Section 4: Role Classification (runs first in pipeline)
    md += `### 4. Role Classification\n\n`
    md += `| Slot | Team | Role | Source |\n`
    md += `|------|------|------|--------|\n`
    for (const rc of r.roles) {
      md += `| ${rc.slot} | ${rc.team} | ${rc.role || '—'} | ${rc.source || '—'} |\n`
    }
    const rolesFound = r.roles.filter(rc => rc.role !== null).length
    md += `\n**Roles classified:** ${rolesFound}/10\n\n`

    // Section 2: Hero Identification (with role filtering)
    md += `### 2. Hero Identification\n\n`
    md += `| Slot | Team | Hero | Confidence | Role Filter |\n`
    md += `|------|------|------|------------|-------------|\n`
    for (const h of r.heroes) {
      const role = r.roles.find(rc => rc.slot === h.slot)?.role || '—'
      md += `| ${h.slot} | ${h.team} | ${h.heroName || '—'} | ${(h.confidence * 100).toFixed(1)}% | ${role} |\n`
    }
    const heroesFound = r.heroes.filter(h => h.heroName !== null).length
    md += `\n**Heroes identified:** ${heroesFound}/10\n\n`

    // Section 3: Player Labeling
    md += `### 3. Player Labeling\n\n`
    md += `| Slot | Team | Label | Hero | Is User | Match Method |\n`
    md += `|------|------|-------|------|---------|---------------|\n`
    for (const p of r.players) {
      md += `| ${p.slot} | ${p.team} | ${p.displayName || '—'} | ${p.heroName || '—'} | ${p.isUser ? 'YES' : '—'} | ${p.userMatchMethod || '—'} |\n`
    }
    const userFound = r.players.some(p => p.isUser)
    md += `\n**User identified:** ${userFound ? 'Yes' : 'No'}\n\n`

    // Section 5: Stats Extraction
    md += `### 5. Stats Extraction\n\n`
    md += `**Ally Team:**\n\n`
    md += `| Slot | Label | Hero | Role | E | A | D | DMG | H | MIT |\n`
    md += `|------|-------|------|------|---|---|---|-----|---|-----|\n`
    for (const s of r.stats.filter(s => s.team === 'ally')) {
      const player = r.players.find(p => p.slot === s.slot)
      const displayLabel = player?.isUser ? `**${player.displayName}**` : (player?.displayName || '—')
      md += `| ${s.slot} | ${displayLabel} | ${s.heroName || '—'} | ${s.role || '—'} | ${s.eliminations ?? '—'} | ${s.assists ?? '—'} | ${s.deaths ?? '—'} | ${s.damage?.toLocaleString() ?? '—'} | ${s.healing?.toLocaleString() ?? '—'} | ${s.mitigation?.toLocaleString() ?? '—'} |\n`
    }

    md += `\n**Enemy Team:**\n\n`
    md += `| Slot | Label | Hero | Role | E | A | D | DMG | H | MIT |\n`
    md += `|------|-------|------|------|---|---|---|-----|---|-----|\n`
    for (const s of r.stats.filter(s => s.team === 'enemy')) {
      const displayLabel = r.players.find(p => p.slot === s.slot)?.displayName || '—'
      md += `| ${s.slot} | ${displayLabel} | ${s.heroName || '—'} | ${s.role || '—'} | ${s.eliminations ?? '—'} | ${s.assists ?? '—'} | ${s.deaths ?? '—'} | ${s.damage?.toLocaleString() ?? '—'} | ${s.healing?.toLocaleString() ?? '—'} | ${s.mitigation?.toLocaleString() ?? '—'} |\n`
    }

    const statsPopulated = r.stats.filter(s =>
      s.eliminations !== null || s.damage !== null
    ).length
    md += `\n**Players with stats:** ${statsPopulated}/10\n\n`

    md += `---\n\n`
  }

  // Overall summary
  md += `## Overall Summary\n\n`
  const detected = results.filter(r => r.detection.imageType === 'scoreboard').length
  const allHeroes = results.flatMap(r => r.heroes)
  const totalHeroesFound = allHeroes.filter(h => h.heroName !== null).length
  const totalHeroes = allHeroes.length
  const usersFound = results.filter(r => r.players.some(p => p.isUser)).length
  const allRoles = results.flatMap(r => r.roles)
  const totalRolesFound = allRoles.filter(rc => rc.role !== null).length
  const allStats = results.flatMap(r => r.stats)
  const totalStatsPopulated = allStats.filter(s => s.eliminations !== null).length

  md += `| Metric | Value |\n|--------|-------|\n`
  md += `| Images tested | ${results.length} |\n`
  md += `| Scoreboards detected | ${detected}/${results.length} |\n`
  md += `| Heroes identified | ${totalHeroesFound}/${totalHeroes} |\n`
  md += `| User identified | ${usersFound}/${results.length} images |\n`
  md += `| Roles classified | ${totalRolesFound}/${allRoles.length} |\n`
  md += `| Players with stats | ${totalStatsPopulated}/${allStats.length} |\n`

  return md
}

// ============================================================
// SECTION COMPONENTS
// ============================================================

function SectionHeader({
  number,
  title,
  status,
  isOpen,
  onToggle,
}: {
  number: number
  title: string
  status: 'pass' | 'fail' | 'empty' | 'skipped'
  isOpen: boolean
  onToggle: () => void
}) {
  const statusColors = {
    pass: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50',
    fail: 'bg-red-900/50 text-red-300 border-red-700/50',
    empty: 'bg-slate-800 text-slate-400 border-slate-700/50',
    skipped: 'bg-amber-900/40 text-amber-300 border-amber-700/50',
  }
  const statusLabels = {
    pass: 'PASS',
    fail: 'ISSUES',
    empty: 'NO DATA',
    skipped: 'SKIPPED',
  }

  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between py-3 px-4 bg-slate-900/80 hover:bg-slate-900 rounded-lg transition-colors"
    >
      <div className="flex items-center gap-3">
        <span className="text-xs font-mono text-slate-500 w-4">{number}</span>
        <span className="font-semibold text-sm text-slate-200">{title}</span>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${statusColors[status]}`}>
          {statusLabels[status]}
        </span>
      </div>
      <span className={`text-slate-500 text-xs transition-transform ${isOpen ? 'rotate-180' : ''}`}>
        ▼
      </span>
    </button>
  )
}

function DetectionSection({ result }: { result: ScoreboardDetectionResult }) {
  const typeColors: Record<string, string> = {
    scoreboard: 'text-emerald-400',
    summary: 'text-blue-400',
    breakdown: 'text-purple-400',
    unknown: 'text-slate-500',
  }

  return (
    <div className="px-4 pb-4 pt-2 space-y-3">
      <div className="flex items-center gap-6">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Type Detected</p>
          <p className={`text-lg font-bold ${typeColors[result.imageType] || 'text-slate-500'}`}>
            {result.imageType.toUpperCase()}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Confidence</p>
          <p className="text-lg font-bold text-slate-300">
            {(result.confidence * 100).toFixed(1)}%
          </p>
        </div>
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Detection Signals</p>
        {result.signals.map((s, i) => (
          <p key={i} className="text-xs text-slate-400 font-mono">• {s}</p>
        ))}
      </div>
      {result.imageType !== 'scoreboard' && (
        <div className="bg-amber-900/20 border border-amber-700/30 rounded px-3 py-2">
          <p className="text-xs text-amber-300">
            Image not classified as scoreboard — remaining extraction steps will be skipped.
          </p>
        </div>
      )}
      {result.grid && (
        <div className="mt-2">
          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Grid Mapping</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-slate-800/40 rounded px-3 py-2">
              <p className="text-[10px] text-blue-400 uppercase tracking-wider mb-1">Ally Section</p>
              <p className="text-xs text-slate-400 font-mono">
                y={result.grid.ally.startY}–{result.grid.ally.endY} · {result.grid.ally.rowHeight.toFixed(0)}px/row
              </p>
              {result.grid.rows.filter(r => r.team === 'ally').map(r => (
                <p key={r.slot} className="text-[10px] text-slate-500 font-mono">
                  Row {r.slot}: y={r.topY}–{r.bottomY} (center {r.centerY})
                </p>
              ))}
            </div>
            <div className="bg-slate-800/40 rounded px-3 py-2">
              <p className="text-[10px] text-red-400 uppercase tracking-wider mb-1">Enemy Section</p>
              <p className="text-xs text-slate-400 font-mono">
                y={result.grid.enemy.startY}–{result.grid.enemy.endY} · {result.grid.enemy.rowHeight.toFixed(0)}px/row
              </p>
              {result.grid.rows.filter(r => r.team === 'enemy').map(r => (
                <p key={r.slot} className="text-[10px] text-slate-500 font-mono">
                  Row {r.slot}: y={r.topY}–{r.bottomY} (center {r.centerY})
                </p>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function HeroSection({ heroes, roles }: { heroes: ScoreboardHeroIdentification[]; roles: ScoreboardRoleClassification[] }) {
  const ally = heroes.filter(h => h.team === 'ally')
  const enemy = heroes.filter(h => h.team === 'enemy')

  const TeamTable = ({ players, label, color }: {
    players: ScoreboardHeroIdentification[]
    label: string
    color: string
  }) => (
    <div>
      <p className={`text-[10px] uppercase tracking-wider mb-2 ${color}`}>{label}</p>
      <div className="space-y-1">
        {players.map(h => {
          const role = roles.find(r => r.slot === h.slot)?.role
          return (
            <div key={h.slot} className="flex items-center gap-3 bg-slate-800/60 rounded px-3 py-2">
              <span className="text-xs font-mono text-slate-500 w-4">{h.slot}</span>
              <span className={`text-[10px] font-bold uppercase w-12 ${
                role === 'tank' ? 'text-blue-300' :
                role === 'dps' ? 'text-red-300' :
                role === 'support' ? 'text-green-300' :
                'text-slate-600'
              }`}>
                {role || '—'}
              </span>
              {h.portraitDataUrl ? (
                <img
                  src={h.portraitDataUrl}
                  alt=""
                  className="w-8 h-8 rounded object-cover border border-slate-700"
                />
              ) : (
                <div className="w-8 h-8 rounded bg-slate-700/50 border border-slate-700 flex items-center justify-center">
                  <span className="text-[10px] text-slate-600">?</span>
                </div>
              )}
              <span className={`text-sm font-medium flex-1 ${h.heroName ? 'text-slate-200' : 'text-slate-600'}`}>
                {h.heroName || 'Not identified'}
              </span>
              <span className={`text-xs font-mono ${
                h.confidence >= 0.8 ? 'text-emerald-400' :
                h.confidence >= 0.5 ? 'text-amber-400' :
                h.confidence > 0 ? 'text-red-400' : 'text-slate-600'
              }`}>
                {h.confidence > 0 ? `${(h.confidence * 100).toFixed(0)}%` : '—'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )

  return (
    <div className="px-4 pb-4 pt-2 grid grid-cols-2 gap-4">
      <TeamTable players={ally} label="Ally Team" color="text-blue-400" />
      <TeamTable players={enemy} label="Enemy Team" color="text-red-400" />
    </div>
  )
}

function PlayerSection({ players }: { players: ScoreboardPlayerLabel[] }) {
  const ally = players.filter(p => p.team === 'ally')
  const enemy = players.filter(p => p.team === 'enemy')

  const TeamTable = ({ rows, label, color }: {
    rows: ScoreboardPlayerLabel[]
    label: string
    color: string
  }) => (
    <div>
      <p className={`text-[10px] uppercase tracking-wider mb-2 ${color}`}>{label}</p>
      <div className="space-y-1">
        {rows.map(p => (
          <div
            key={p.slot}
            className={`flex items-center gap-3 rounded px-3 py-2 ${
              p.isUser
                ? 'bg-amber-900/30 border border-amber-600/40'
                : 'bg-slate-800/60'
            }`}
          >
            <span className="text-xs font-mono text-slate-500 w-4">{p.slot}</span>
            <span className={`text-sm font-medium flex-1 ${p.displayName ? 'text-slate-200' : 'text-slate-600'}`}>
              {p.displayName || 'Unknown'}
            </span>
            <span className={`text-xs text-slate-400 ${p.heroName ? '' : 'text-slate-600'}`}>
              {p.heroName || '—'}
            </span>
            {p.isUser && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-800/60 text-amber-300 border border-amber-700/50">
                USER
              </span>
            )}
            <span className="text-xs text-slate-500 font-mono">
              {p.userMatchMethod || '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div className="px-4 pb-4 pt-2 grid grid-cols-2 gap-4">
      <TeamTable rows={ally} label="Ally Team" color="text-blue-400" />
      <TeamTable rows={enemy} label="Enemy Team" color="text-red-400" />
    </div>
  )
}

function RoleSection({ roles }: { roles: ScoreboardRoleClassification[] }) {
  const ally = roles.filter(r => r.team === 'ally')
  const enemy = roles.filter(r => r.team === 'enemy')

  const TeamTable = ({ rows, label, color }: {
    rows: ScoreboardRoleClassification[]
    label: string
    color: string
  }) => (
    <div>
      <p className={`text-[10px] uppercase tracking-wider mb-2 ${color}`}>{label}</p>
      <div className="space-y-1">
        {rows.map(rc => (
          <div key={rc.slot} className="flex items-center gap-3 bg-slate-800/60 rounded px-3 py-2">
            <span className="text-xs font-mono text-slate-500 w-4">{rc.slot}</span>
            <span className={`text-xs font-bold uppercase w-16 ${
              rc.role === 'tank' ? 'text-blue-300' :
              rc.role === 'dps' ? 'text-red-300' :
              rc.role === 'support' ? 'text-green-300' :
              'text-slate-600'
            }`}>
              {rc.role || '—'}
            </span>
            <span className={`text-sm flex-1 ${rc.heroName ? 'text-slate-200' : 'text-slate-600'}`}>
              {rc.heroName || '—'}
            </span>
            <span className="text-[10px] text-slate-500 font-mono">
              {rc.source || '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div className="px-4 pb-4 pt-2 grid grid-cols-2 gap-4">
      <TeamTable rows={ally} label="Ally Team" color="text-blue-400" />
      <TeamTable rows={enemy} label="Enemy Team" color="text-red-400" />
    </div>
  )
}

function StatsSection({ stats, players }: { stats: ScoreboardPlayerStats[]; players: ScoreboardPlayerLabel[] }) {
  const ally = stats.filter(s => s.team === 'ally')
  const enemy = stats.filter(s => s.team === 'enemy')

  const fmt = (v: number | null) => v !== null ? v.toLocaleString() : '—'

  const StatsTable = ({ rows, label, color }: {
    rows: ScoreboardPlayerStats[]
    label: string
    color: string
  }) => (
    <div>
      <p className={`text-[10px] uppercase tracking-wider mb-2 ${color}`}>{label}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-500 text-[10px] uppercase tracking-wider">
              <th className="text-left py-1 px-2 font-medium">#</th>
              <th className="text-left py-1 px-2 font-medium">Label</th>
              <th className="text-left py-1 px-2 font-medium">Hero</th>
              <th className="text-right py-1 px-2 font-medium">E</th>
              <th className="text-right py-1 px-2 font-medium">A</th>
              <th className="text-right py-1 px-2 font-medium">D</th>
              <th className="text-right py-1 px-2 font-medium">DMG</th>
              <th className="text-right py-1 px-2 font-medium">H</th>
              <th className="text-right py-1 px-2 font-medium">MIT</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(s => {
              const player = players.find(p => p.slot === s.slot)
              return (
                <tr
                  key={s.slot}
                  className={`border-t border-slate-800/50 ${
                    player?.isUser ? 'bg-amber-900/20' : ''
                  }`}
                >
                  <td className="py-1.5 px-2 font-mono text-slate-500">{s.slot}</td>
                  <td className={`py-1.5 px-2 font-medium ${player?.displayName ? 'text-slate-200' : 'text-slate-600'}`}>
                    {player?.displayName || '—'}
                  </td>
                  <td className={`py-1.5 px-2 ${s.heroName ? 'text-slate-300' : 'text-slate-600'}`}>
                    {s.heroName || '—'}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono text-slate-300">{fmt(s.eliminations)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-slate-300">{fmt(s.assists)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-slate-300">{fmt(s.deaths)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-slate-300">{fmt(s.damage)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-slate-300">{fmt(s.healing)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-slate-300">{fmt(s.mitigation)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )

  return (
    <div className="px-4 pb-4 pt-2 space-y-4">
      <StatsTable rows={ally} label="Ally Team" color="text-blue-400" />
      <StatsTable rows={enemy} label="Enemy Team" color="text-red-400" />
    </div>
  )
}

// ============================================================
// USER CONFIRMATION PROMPT
// Shown when OCR can't confidently identify the user
// ============================================================

function UserConfirmationPrompt({
  result,
  step,
  onConfirm,
  onDecline,
  onSelect,
}: {
  result: ScoreboardTestResult
  step: 'confirm' | 'select'
  onConfirm: (slot: number) => void
  onDecline: () => void
  onSelect: (slot: number) => void
}) {
  const analysis = result.ocrAnalysis
  if (!analysis) return null

  const bestCandidate = analysis.candidates.find(
    c => c.slot === analysis.bestCandidate.slot
  )

  if (step === 'confirm' && bestCandidate) {
    return (
      <div className="bg-amber-950/30 border border-amber-700/40 rounded-xl p-5 mb-5">
        <p className="text-sm font-semibold text-amber-200 mb-1">
          User identification needed — {result.filename}
        </p>
        <p className="text-xs text-amber-300/70 mb-4">
          OCR wasn&apos;t confident enough to auto-identify
          (best: {(analysis.bestCandidate.similarity * 100).toFixed(0)}% similarity,
          {(analysis.bestCandidate.margin * 100).toFixed(0)}% margin).
          Is this you?
        </p>

        <div className="flex items-center gap-4 bg-slate-900/60 rounded-lg p-4 mb-4">
          {bestCandidate.heroPortraitUrl && (
            <img
              src={bestCandidate.heroPortraitUrl}
              alt=""
              className="w-14 h-14 rounded border border-slate-600"
            />
          )}
          <div className="flex-1 min-w-0">
            {bestCandidate.gamertagCropUrl && (
              <img
                src={bestCandidate.gamertagCropUrl}
                alt=""
                className="h-8 rounded mb-1"
                style={{ imageRendering: 'auto' }}
              />
            )}
            <p className="text-xs text-slate-400">
              Slot {bestCandidate.slot} · {bestCandidate.heroName || 'Unknown hero'}
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => onConfirm(bestCandidate.slot)}
            className="bg-emerald-700 hover:bg-emerald-600 text-white text-sm px-5 py-2 rounded-lg font-medium transition-colors"
          >
            Yes, that&apos;s me
          </button>
          <button
            onClick={onDecline}
            className="bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm px-5 py-2 rounded-lg font-medium transition-colors"
          >
            No, show all options
          </button>
        </div>
      </div>
    )
  }

  // step === 'select' — show all 5 ally candidates
  return (
    <div className="bg-amber-950/30 border border-amber-700/40 rounded-xl p-5 mb-5">
      <p className="text-sm font-semibold text-amber-200 mb-1">
        Which one is you? — {result.filename}
      </p>
      <p className="text-xs text-amber-300/70 mb-4">
        Select your player from the ally team.
      </p>

      <div className="space-y-2">
        {analysis.candidates.map(candidate => (
          <button
            key={candidate.slot}
            onClick={() => onSelect(candidate.slot)}
            className="w-full flex items-center gap-4 bg-slate-900/60 hover:bg-slate-800/80 rounded-lg p-3 transition-colors text-left border border-transparent hover:border-slate-600"
          >
            {candidate.heroPortraitUrl && (
              <img
                src={candidate.heroPortraitUrl}
                alt=""
                className="w-12 h-12 rounded border border-slate-600 flex-shrink-0"
              />
            )}
            <div className="flex-1 min-w-0">
              {candidate.gamertagCropUrl && (
                <img
                  src={candidate.gamertagCropUrl}
                  alt=""
                  className="h-7 rounded mb-1"
                  style={{ imageRendering: 'auto' }}
                />
              )}
              <p className="text-xs text-slate-400">
                Slot {candidate.slot} · {candidate.heroName || 'Unknown hero'}
              </p>
            </div>
            <span className="text-xs font-mono text-slate-500">
              OCR: {(candidate.ocrSimilarity * 100).toFixed(0)}%
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ============================================================
// RESULT CARD — one per uploaded image
// ============================================================

function ResultCard({ result }: { result: ScoreboardTestResult }) {
  const [openSections, setOpenSections] = useState<Set<number>>(new Set([1]))

  const toggle = (section: number) => {
    setOpenSections(prev => {
      const next = new Set(prev)
      next.has(section) ? next.delete(section) : next.add(section)
      return next
    })
  }

  const isScoreboard = result.detection.imageType === 'scoreboard'

  const getDetectionStatus = (): 'pass' | 'fail' | 'empty' => {
    if (result.detection.confidence === 0) return 'empty'
    return result.detection.imageType === 'scoreboard' ? 'pass' : 'fail'
  }

  const getHeroStatus = (): 'pass' | 'fail' | 'empty' | 'skipped' => {
    if (!isScoreboard) return 'skipped'
    const found = result.heroes.filter(h => h.heroName !== null).length
    if (found === 0) return 'empty'
    return found === 10 ? 'pass' : 'fail'
  }

  const getPlayerStatus = (): 'pass' | 'fail' | 'empty' | 'skipped' => {
    if (!isScoreboard) return 'skipped'
    const userFound = result.players.some(p => p.isUser)
    if (result.ocrAnalysis && !result.ocrAnalysis.resolved) return 'fail'
    if (!result.players.some(p => p.positionalLabel !== null)) return 'empty'
    return userFound ? 'pass' : 'fail'
  }

  const getRoleStatus = (): 'pass' | 'fail' | 'empty' | 'skipped' => {
    if (!isScoreboard) return 'skipped'
    const found = result.roles.filter(r => r.role !== null).length
    if (found === 0) return 'empty'
    return found === 10 ? 'pass' : 'fail'
  }

  const getStatsStatus = (): 'pass' | 'fail' | 'empty' | 'skipped' => {
    if (!isScoreboard) return 'skipped'
    const populated = result.stats.filter(s => s.eliminations !== null).length
    if (populated === 0) return 'empty'
    return populated === 10 ? 'pass' : 'fail'
  }

  return (
    <div className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden">
      {/* Image header */}
      <div className="flex items-start gap-4 p-4 border-b border-slate-800/50">
        {result.imageDataUrl && (
          <img
            src={result.imageDataUrl}
            alt={result.filename}
            className="w-48 h-auto rounded border border-slate-700 flex-shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-slate-200 text-sm truncate">{result.filename}</p>
          <p className="text-xs text-slate-500 mt-1">
            {result.imageDimensions.width} × {result.imageDimensions.height} · {result.timestamp}
          </p>
        </div>
      </div>

      {/* Sections */}
      <div className="divide-y divide-slate-800/30">
        {/* 1 — Detection */}
        <div>
          <SectionHeader number={1} title="Detection" status={getDetectionStatus()} isOpen={openSections.has(1)} onToggle={() => toggle(1)} />
          {openSections.has(1) && <DetectionSection result={result.detection} />}
        </div>

        {/* 4 — Role Classification (runs first in pipeline) */}
        <div>
          <SectionHeader number={4} title="Role Classification" status={getRoleStatus()} isOpen={openSections.has(4)} onToggle={() => toggle(4)} />
          {openSections.has(4) && <RoleSection roles={result.roles} />}
        </div>

        {/* 2 — Hero Identification (role-filtered) */}
        <div>
          <SectionHeader number={2} title="Hero Identification" status={getHeroStatus()} isOpen={openSections.has(2)} onToggle={() => toggle(2)} />
          {openSections.has(2) && <HeroSection heroes={result.heroes} roles={result.roles} />}
        </div>

        {/* 3 — Player Labeling */}
        <div>
          <SectionHeader number={3} title="Player Labeling" status={getPlayerStatus()} isOpen={openSections.has(3)} onToggle={() => toggle(3)} />
          {openSections.has(3) && <PlayerSection players={result.players} />}
        </div>

        {/* 5 — Stats Extraction */}
        <div>
          <SectionHeader number={5} title="Stats Extraction" status={getStatsStatus()} isOpen={openSections.has(5)} onToggle={() => toggle(5)} />
          {openSections.has(5) && <StatsSection stats={result.stats} players={result.players} />}
        </div>
      </div>
    </div>
  )
}

// ============================================================
// MAIN PAGE
// ============================================================

export default function TestingPage() {
  const [results, setResults] = useState<ScoreboardTestResult[]>([])
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState('')
  const [testNumber, setTestNumber] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [gamertag, setGamertag] = useState('PyroEagles')
  const [pendingConfirm, setPendingConfirm] = useState<{
    resultId: number
    step: 'confirm' | 'select'
  } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const nextIdRef = useRef(1)

  // Handle user confirmation response
  const handleConfirmUser = useCallback((resultId: number, chosenSlot: number, method: 'ocr_confirmed' | 'manual_select') => {
    setResults(prev => {
      const updated = prev.map(r => {
        if (r.id !== resultId) return r
        return {
          ...r,
          players: buildPlayerLabels(r.heroes, r.roles, gamertag, chosenSlot, method),
          ocrAnalysis: r.ocrAnalysis ? { ...r.ocrAnalysis, resolved: true, userSlot: chosenSlot } : null,
        }
      })

      // Queue next unresolved result
      const nextUnresolved = updated.find(r =>
        r.ocrAnalysis && !r.ocrAnalysis.resolved && r.id !== resultId
      )
      if (nextUnresolved) {
        setPendingConfirm({ resultId: nextUnresolved.id, step: 'confirm' })
      } else {
        setPendingConfirm(null)
      }

      return updated
    })
  }, [gamertag])

  // Decline the suggested candidate, show all 5 options
  const handleDeclineConfirm = useCallback((resultId: number) => {
    setPendingConfirm({ resultId, step: 'select' })
  }, [])

  const processImages = useCallback(async (files: FileList) => {
    setProcessing(true)
    setError(null)

    const newResults: ScoreboardTestResult[] = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      setProgress(`Processing ${i + 1}/${files.length}: ${file.name}...`)

      try {
        // Load image
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image()
          el.onload = () => resolve(el)
          el.onerror = reject
          el.src = URL.createObjectURL(file)
        })

        // Generate thumbnail data URL for display
        const thumbCanvas = document.createElement('canvas')
        const scale = 384 / img.width // thumbnail ~384px wide
        thumbCanvas.width = 384
        thumbCanvas.height = img.height * scale
        const thumbCtx = thumbCanvas.getContext('2d')!
        thumbCtx.drawImage(img, 0, 0, thumbCanvas.width, thumbCanvas.height)
        const imageDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.7)

        // ─── PIPELINE: Step 1 → Step 4 → Step 2 → Step 3 → Step 5 ───

        // Step 1: Detection
        setProgress(`Processing ${i + 1}/${files.length}: ${file.name} — detecting scoreboard...`)
        const detection = await detectScoreboard(img)

        // Step 4: Role classification (icon detection — no heroes needed)
        setProgress(`Processing ${i + 1}/${files.length}: ${file.name} — classifying roles...`)
        const roles = await classifyRoles(img, detection)

        // Step 2: Hero identification (role-filtered from Step 4)
        setProgress(`Processing ${i + 1}/${files.length}: ${file.name} — matching heroes (role-filtered)...`)
        const heroes = await identifyHeroes(img, detection, roles)

        // Backfill hero names into roles
        for (const role of roles) {
          const hero = heroes.find(h => h.slot === role.slot)
          role.heroName = hero?.heroName ?? null
        }

        // Step 3: User identification (OCR analysis — may need confirmation)
        setProgress(`Processing ${i + 1}/${files.length}: ${file.name} — identifying user (OCR)...`)
        const ocrAnalysis = await analyzeUserIdentity(img, heroes, detection, roles, gamertag)

        // Build player labels — auto-resolved or pending confirmation
        const players = buildPlayerLabels(
          heroes, roles, gamertag,
          ocrAnalysis.resolved ? ocrAnalysis.userSlot : null,
          ocrAnalysis.resolved ? 'ocr_auto' : null,
        )

        // Step 5: Stats extraction — runs regardless of user identification status
        setProgress(`Processing ${i + 1}/${files.length}: ${file.name} — extracting stats...`)
        const stats = await extractStats(img, heroes, roles, players, detection)

        const result: ScoreboardTestResult = {
          id: nextIdRef.current++,
          filename: file.name,
          timestamp: new Date().toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
          imageDimensions: { width: img.width, height: img.height },
          imageDataUrl,
          detection,
          heroes,
          players,
          roles,
          stats,
          ocrAnalysis,
        }

        newResults.push(result)
        URL.revokeObjectURL(img.src)
      } catch (err) {
        console.error(`Error processing ${file.name}:`, err)
        setError(`Failed to process "${file.name}": ${err}`)
      }
    }

    // Append new results to existing (supports re-upload)
    setResults(prev => [...prev, ...newResults])
    setProcessing(false)
    setProgress('')
    if (fileRef.current) fileRef.current.value = ''

    // Queue first unresolved result for confirmation
    const firstUnresolved = newResults.find(r =>
      r.ocrAnalysis && !r.ocrAnalysis.resolved
    )
    if (firstUnresolved) {
      setPendingConfirm({ resultId: firstUnresolved.id, step: 'confirm' })
    }
  }, [gamertag])

  const handleFiles = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      processImages(files)
    }
  }, [processImages])

  const downloadReport = useCallback(() => {
    const md = generateReport(testNumber, results)
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `scoreboard-test-${testNumber}-${new Date().toISOString().split('T')[0]}.md`
    a.click()
    URL.revokeObjectURL(url)
  }, [testNumber, results])

  const startNewTest = useCallback(() => {
    setTestNumber(n => n + 1)
    setResults([])
    setError(null)
    nextIdRef.current = 1
  }, [])

  // Summary counts
  const detected = results.filter(r => r.detection.imageType === 'scoreboard').length
  const heroesFound = results.flatMap(r => r.heroes).filter(h => h.heroName !== null).length
  const totalSlots = results.length * 10
  const usersFound = results.filter(r => r.players.some(p => p.isUser)).length
  const rolesFound = results.flatMap(r => r.roles).filter(rc => rc.role !== null).length
  const statsPopulated = results.flatMap(r => r.stats).filter(s => s.eliminations !== null).length

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 sm:p-6">
      <div className="max-w-5xl mx-auto">

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-baseline gap-3 mb-1">
            <h1 className="text-xl sm:text-2xl font-bold text-slate-100">
              Scoreboard Extraction — Testing
            </h1>
            <span className="text-xs font-mono text-slate-500 bg-slate-900 px-2 py-0.5 rounded">
              Test #{testNumber}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            Upload scoreboard screenshots (3840×2160) · Results accumulate across uploads · Download report when done
          </p>
        </div>

        {/* Settings: Gamertag */}
        <div className="mb-4">
          <label className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 block">
            Gamertag
          </label>
          <input
            type="text"
            value={gamertag}
            onChange={(e) => setGamertag(e.target.value)}
            placeholder="Enter gamertag..."
            disabled={processing}
            className="w-full sm:w-72 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-slate-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        {/* Upload area */}
        <div className="border border-dashed border-slate-700 rounded-xl p-5 mb-5 text-center hover:border-slate-600 transition-colors">
          <p className="text-sm text-slate-400 mb-3">
            {results.length === 0
              ? 'Upload scoreboard screenshots to begin'
              : 'Upload more images to add to this test'}
          </p>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*"
            onChange={handleFiles}
            disabled={processing}
            className="text-sm text-slate-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-slate-800 file:text-slate-300 hover:file:bg-slate-700 file:cursor-pointer disabled:opacity-50"
          />
        </div>

        {/* Processing indicator */}
        {processing && (
          <div className="bg-blue-950/40 border border-blue-800/30 rounded-lg p-3 mb-5 flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            <p className="text-sm text-blue-300">{progress}</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-950/40 border border-red-800/30 rounded-lg p-3 mb-5">
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <>
            {/* Summary bar */}
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-5">
              {[
                { label: 'Images', value: `${results.length}`, sub: null },
                { label: 'Detected', value: `${detected}/${results.length}`, good: detected === results.length },
                { label: 'Roles', value: `${rolesFound}/${totalSlots}`, good: rolesFound === totalSlots },
                { label: 'Heroes', value: `${heroesFound}/${totalSlots}`, good: heroesFound === totalSlots },
                { label: 'User ID', value: `${usersFound}/${results.length}`, good: usersFound === results.length },
                { label: 'Stats', value: `${statsPopulated}/${totalSlots}`, good: statsPopulated === totalSlots },
              ].map((item, i) => (
                <div key={i} className="bg-slate-900/60 border border-slate-800/50 rounded-lg p-3 text-center">
                  <p className={`text-lg font-bold font-mono ${
                    item.good === undefined ? 'text-slate-200' :
                    item.good ? 'text-emerald-400' : 'text-slate-400'
                  }`}>
                    {item.value}
                  </p>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">{item.label}</p>
                </div>
              ))}
            </div>

            {/* Action buttons */}
            <div className="flex gap-2 mb-6">
              <button
                onClick={downloadReport}
                className="bg-blue-700 hover:bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium transition-colors"
              >
                Download Report (.md)
              </button>
              <button
                onClick={startNewTest}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm px-4 py-2 rounded-lg font-medium transition-colors"
              >
                New Test (#{testNumber + 1})
              </button>
            </div>

            {/* User confirmation prompt */}
            {pendingConfirm && (() => {
              const pendingResult = results.find(r => r.id === pendingConfirm.resultId)
              if (!pendingResult) return null
              return (
                <UserConfirmationPrompt
                  result={pendingResult}
                  step={pendingConfirm.step}
                  onConfirm={(slot) => handleConfirmUser(pendingResult.id, slot, 'ocr_confirmed')}
                  onDecline={() => handleDeclineConfirm(pendingResult.id)}
                  onSelect={(slot) => handleConfirmUser(pendingResult.id, slot, 'manual_select')}
                />
              )
            })()}

            {/* Result cards */}
            <div className="space-y-4">
              {results.map(r => (
                <ResultCard key={r.id} result={r} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
