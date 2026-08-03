import type { IpoAttribution } from '../lib/applicationAttribution'

const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-other']

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

// Hand-rolled pie via conic-gradient — no charting library, same spirit as
// the rest of this app's charts. Colors come from the --series-* tokens,
// never hardcoded, so it's theme-reactive for free.
function pieGradient(slices: { value: number }[], total: number): string {
  let acc = 0
  const stops = slices.map((s, i) => {
    const start = (acc / total) * 100
    acc += s.value
    const end = (acc / total) * 100
    return `var(${SERIES_VARS[i] ?? '--series-other'}) ${start}% ${end}%`
  })
  return `conic-gradient(${stops.join(', ')})`
}

export function AttributionChart({ attribution, compact = false }: { attribution: IpoAttribution; compact?: boolean }) {
  const { companyName, totalApplications, slices } = attribution
  if (totalApplications === 0 || slices.length === 0) return null

  const size = compact ? 64 : 84

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p
          className={`truncate ${compact ? 'text-sm font-medium' : 'text-sm font-semibold'}`}
          style={{ color: 'var(--ink-primary)' }}
        >
          {companyName}
        </p>
        <span className="shrink-0 text-xs" style={{ color: 'var(--ink-muted)' }}>
          {totalApplications} app{totalApplications === 1 ? '' : 's'}
        </span>
      </div>

      <div className="flex items-center gap-4">
        <div
          className="shrink-0 rounded-full"
          style={{
            width: size,
            height: size,
            background: pieGradient(slices, totalApplications),
            boxShadow: 'inset 0 0 0 1px var(--border)',
          }}
        />
        <div className="flex flex-col gap-1 text-xs">
          {slices.map((s, i) => {
            const pct = (s.value / totalApplications) * 100
            return (
              <div key={s.name} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ background: `var(${SERIES_VARS[i] ?? '--series-other'})` }}
                />
                <span style={{ color: 'var(--ink-secondary)' }}>
                  {s.name} — {formatCount(s.value)} ({pct.toFixed(0)}%)
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
