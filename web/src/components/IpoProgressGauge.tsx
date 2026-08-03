// Hand-rolled half-donut gauge (SVG arc via pathLength/dasharray) — no
// charting library, same spirit as the other charts in this app. Fill grows
// with `applied`, so it visibly advances as more accounts apply.
export function IpoProgressGauge({
  companyName,
  startDate,
  endDate,
  applied,
  total,
  gmpNotes,
}: {
  companyName: string
  startDate: string
  endDate: string
  applied: number
  total: number
  gmpNotes: string | null
}) {
  const pct = total > 0 ? Math.min(applied / total, 1) : 0
  const accountsLeft = Math.max(total - applied, 0)

  const size = 160
  const r = 68
  const cx = size / 2
  const cy = size / 2 + 4
  const arcPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`
  const angle = Math.PI * (1 - pct)
  const dotX = cx + r * Math.cos(angle)
  const dotY = cy - r * Math.sin(angle)

  return (
    <div className="card stagger-item p-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p
            className="truncate text-sm font-semibold underline decoration-2 underline-offset-2"
            style={{ color: 'var(--ink-primary)' }}
          >
            {companyName}
          </p>
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            {startDate} – {endDate}
          </p>
        </div>
        <span className="badge badge-neutral shrink-0 text-xs">{accountsLeft} left</span>
      </div>

      <svg viewBox={`0 0 ${size} ${size / 2 + 16}`} className="w-full">
        <path d={arcPath} fill="none" stroke="var(--border)" strokeWidth={10} strokeLinecap="round" />
        <path
          d={arcPath}
          fill="none"
          stroke="var(--good)"
          strokeWidth={10}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={100}
          strokeDashoffset={100 - pct * 100}
          style={{ transition: 'stroke-dashoffset 0.5s cubic-bezier(0.16, 1, 0.3, 1)' }}
        />
        {pct > 0 && <circle cx={dotX} cy={dotY} r={5} fill="var(--good)" stroke="var(--surface)" strokeWidth={2} />}
      </svg>

      <div className="-mt-1 text-center">
        <p className="text-sm font-semibold" style={{ color: 'var(--ink-primary)', fontVariantNumeric: 'tabular-nums' }}>
          {applied}/{total}
        </p>
        <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
          applied / active accounts
        </p>
        {gmpNotes && (
          <p className="mt-1 truncate text-xs" style={{ color: 'var(--ink-secondary)' }}>
            GMP: {gmpNotes}
          </p>
        )}
      </div>
    </div>
  )
}
