import type { IpoAttribution } from '../lib/applicationAttribution'

const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-other']

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

// Hand-rolled, no charting library — same spirit as AreaChart.tsx. A stacked
// bar reads as plain flex children with percentage widths rather than SVG
// paths, which is simpler for this shape of data. Colors come from the
// --series-* tokens (dataviz skill's validated categorical slots), never
// hardcoded, so it's theme-reactive for free.
export function AttributionChart({ attribution, compact = false }: { attribution: IpoAttribution; compact?: boolean }) {
  const { companyName, totalApplications, slices } = attribution
  if (totalApplications === 0 || slices.length === 0) return null

  const barHeight = compact ? 10 : 14

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

      <div
        className="flex w-full overflow-hidden rounded-full"
        style={{ height: barHeight, background: 'var(--border)', gap: 2 }}
      >
        {slices.map((s, i) => {
          const pct = (s.value / totalApplications) * 100
          return (
            <div
              key={s.name}
              title={`${s.name} — ${formatCount(s.value)} (${pct.toFixed(0)}%)`}
              className="animate-chart-grow h-full"
              style={{ width: `${pct}%`, background: `var(${SERIES_VARS[i] ?? '--series-other'})` }}
            />
          )
        })}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
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
  )
}
