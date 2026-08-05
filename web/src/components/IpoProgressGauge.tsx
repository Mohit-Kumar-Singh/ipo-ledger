import { useEffect, useState } from 'react'
import { useCountUp } from '../lib/useCountUp'

// Hand-rolled half-donut gauge (SVG arc via pathLength/dasharray) — no
// charting library, same spirit as the other charts in this app. Fill grows
// with `applied`, so it visibly advances as more accounts apply, and draws
// in from zero on mount (same trick as AttributionChart's sweep-in: render
// the "before" state first, flip to the real value a frame later so the
// CSS transition animates it).
export function IpoProgressGauge({
  companyName,
  startDate,
  endDate,
  applied,
  total,
  gmpNotes,
  remainingHolderNames,
}: {
  companyName: string
  startDate: string
  endDate: string
  applied: number
  total: number
  gmpNotes: string | null
  remainingHolderNames: string[]
}) {
  const [grown, setGrown] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const pct = total > 0 ? Math.min(applied / total, 1) : 0
  const drawnPct = grown ? pct : 0
  const accountsLeft = Math.max(total - applied, 0)
  const animatedApplied = useCountUp(applied)

  const size = 160
  const r = 68
  const cx = size / 2
  const cy = size / 2 + 4
  const arcPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`
  const angle = Math.PI * (1 - drawnPct)
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
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          disabled={accountsLeft === 0}
          aria-expanded={expanded}
          className="badge badge-neutral shrink-0 text-xs disabled:cursor-default"
          style={{ cursor: accountsLeft > 0 ? 'pointer' : undefined }}
        >
          {accountsLeft} left
        </button>
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
          strokeDashoffset={100 - drawnPct * 100}
          style={{ transition: 'stroke-dashoffset 0.7s cubic-bezier(0.16, 1, 0.3, 1)' }}
        />
        {drawnPct > 0 && (
          <circle
            cx={dotX}
            cy={dotY}
            r={5}
            fill="var(--good)"
            stroke="var(--surface)"
            strokeWidth={2}
            style={{ transition: 'cx 0.7s cubic-bezier(0.16, 1, 0.3, 1), cy 0.7s cubic-bezier(0.16, 1, 0.3, 1)' }}
          />
        )}
      </svg>

      <div className="-mt-1 text-center">
        <p className="text-sm font-semibold" style={{ color: 'var(--ink-primary)', fontVariantNumeric: 'tabular-nums' }}>
          {animatedApplied}/{total}
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

      {/* Grid-rows 0fr->1fr trick: animates height to content's natural size
          without knowing it in advance, then the inner list scrolls once
          expanded rather than growing the tile without bound. */}
      <div
        style={{
          display: 'grid',
          gridTemplateRows: expanded ? '1fr' : '0fr',
          transition: 'grid-template-rows 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div className="overflow-hidden">
          <div className="mt-3 border-t pt-2 text-left" style={{ borderColor: 'var(--border)' }}>
            <p className="mb-1 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              Accounts yet to apply ({remainingHolderNames.length})
            </p>
            <ul className="max-h-40 overflow-y-auto">
              {remainingHolderNames.map((name) => (
                <li
                  key={name}
                  className="truncate border-b py-1.5 text-xs last:border-b-0"
                  style={{ borderColor: 'var(--border)', color: 'var(--ink-secondary)' }}
                >
                  {name}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
