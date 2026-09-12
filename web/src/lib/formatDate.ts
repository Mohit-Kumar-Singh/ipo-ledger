// Shared "8th Sep" / "TBA" formatting — originally lived only inside
// IpoTimeline, but PayoutsPage's per-IPO allotment-date display needs the
// exact same rendering (same date, shown in a different place, should read
// identically both places rather than drifting into two slightly different
// formats).
function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

// weekday optional — 'long' ("Wednesday") for a standalone date mention
// with room to spare, 'short' ("Wed") for a tight, multi-date layout
// (IpoTimeline's 4-across milestone row). Omitted entirely keeps the
// original bare "16th Sep" every existing caller already expects, so
// adding this parameter couldn't change anyone's current display.
export function formatShortDate(iso: string | null | undefined, opts?: { weekday?: 'long' | 'short' }): string {
  if (!iso) return 'TBA'
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  const base = `${ordinal(d)} ${month}`
  if (!opts?.weekday) return base
  const weekday = date.toLocaleString('en-US', { weekday: opts.weekday, timeZone: 'UTC' })
  return `${base} · ${weekday}`
}
