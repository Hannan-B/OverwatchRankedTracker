// ============================================================
// DATE FORMATTING — British display (DD-MM-YYYY, 24-hour)
// ------------------------------------------------------------
// Dates are STORED as proper timestamps (ISO) so all date math —
// session grouping, season bucketing, sorting — works correctly.
// These helpers are for DISPLAY only: render British DD-MM-YYYY
// with 24-hour time wherever a match date is shown in the UI.
// ============================================================

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** "18-05-2026" */
export function formatBritishDate(input: Date | string | null | undefined): string {
  if (!input) return '—'
  const d = typeof input === 'string' ? new Date(input) : input
  if (isNaN(d.getTime())) return '—'
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`
}

/** "21:36" (24-hour) */
export function formatBritishTime(input: Date | string | null | undefined): string {
  if (!input) return '—'
  const d = typeof input === 'string' ? new Date(input) : input
  if (isNaN(d.getTime())) return '—'
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "18-05-2026 21:36" */
export function formatBritishDateTime(input: Date | string | null | undefined): string {
  if (!input) return '—'
  const d = typeof input === 'string' ? new Date(input) : input
  if (isNaN(d.getTime())) return '—'
  return `${formatBritishDate(d)} ${formatBritishTime(d)}`
}
