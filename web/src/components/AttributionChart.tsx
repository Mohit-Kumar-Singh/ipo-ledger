import { useEffect, useState } from 'react'
import type { IpoAttribution } from '../lib/applicationAttribution'

const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-other']

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

// First token of the name only ("Mohit Kumar Singh" -> "Mohit") — the
// legend needs to fit name + count + percent in a narrow tile, and the
// count/percent matter more there than the full name (full name is still
// shown as the tile/page's own heading context elsewhere).
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

// Hand-rolled SVG donut (stacked stroke-dasharray arcs on a shared circle) —
// no charting library, same spirit as IpoProgressGauge's SVG arc. A thick
// ring (not a solid disc) with a thin surface-colored gap between segments,
// external percentage labels on slices big enough to hold one, and a
// sweep-in entrance driven the same way as the gauge: render the "before"
// state on mount, flip to the real dasharray a frame later so the CSS
// transition animates it in.
export function AttributionChart({ attribution, compact = false }: { attribution: IpoAttribution; compact?: boolean }) {
  const { companyName, totalApplications, slices } = attribution
  const [grown, setGrown] = useState(false)

  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  if (totalApplications === 0 || slices.length === 0) return null

  const size = compact ? 96 : 128
  const strokeWidth = compact ? 14 : 18
  const r = size / 2 - strokeWidth / 2 - (compact ? 10 : 14) // leaves room for external labels
  const cx = size / 2
  const cy = size / 2
  const circumference = 2 * Math.PI * r
  const gapPct = Math.min(2.4, 60 / circumference) // ~2px surface gap between segments, in path-length %

  let accPct = 0
  const geometry = slices.map((s) => {
    const rawPct = (s.value / totalApplications) * 100
    const startPct = accPct
    accPct += rawPct
    const visiblePct = Math.max(rawPct - gapPct, 0)
    const midAngleDeg = (startPct + rawPct / 2) * 3.6 - 90
    return { ...s, rawPct, startPct, visiblePct, midAngleDeg }
  })

  return (
    <div className="min-w-0">
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

      <div className="flex min-w-0 items-center gap-4">
        <svg width={size} height={size} className="shrink-0 overflow-visible">
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth={strokeWidth} opacity={0.5} />
          <g transform={`rotate(-90 ${cx} ${cy})`}>
            {geometry.map((g, i) => (
              <circle
                key={g.name}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={`var(${SERIES_VARS[i] ?? '--series-other'})`}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                pathLength={100}
                strokeDasharray={grown ? `${g.visiblePct} ${100 - g.visiblePct}` : '0 100'}
                strokeDashoffset={-g.startPct}
                style={{
                  transition: `stroke-dasharray 0.6s cubic-bezier(0.16, 1, 0.3, 1) ${i * 0.08}s`,
                }}
              />
            ))}
          </g>
          {geometry.map(
            (g, i) =>
              g.rawPct >= 8 && (
                <ExternalLabel
                  key={g.name}
                  cx={cx}
                  cy={cy}
                  r={r + strokeWidth / 2 + (compact ? 7 : 9)}
                  angleDeg={g.midAngleDeg}
                  text={`${Math.round(g.rawPct)}%`}
                  compact={compact}
                  delay={i * 0.08 + 0.3}
                  visible={grown}
                />
              ),
          )}
        </svg>
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
          {geometry.map((s, i) => (
            <div key={s.name} className="flex min-w-0 items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: `var(${SERIES_VARS[i] ?? '--series-other'})` }}
              />
              <span
                className="truncate"
                style={{ color: 'var(--ink-secondary)' }}
                title={s.members ? `Other: ${s.members.join(', ')}` : s.name}
              >
                {firstName(s.name)} — {formatCount(s.value)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ExternalLabel({
  cx,
  cy,
  r,
  angleDeg,
  text,
  compact,
  delay,
  visible,
}: {
  cx: number
  cy: number
  r: number
  angleDeg: number
  text: string
  compact: boolean
  delay: number
  visible: boolean
}) {
  const rad = (angleDeg * Math.PI) / 180
  const x = cx + r * Math.cos(rad)
  const y = cy + r * Math.sin(rad)
  // Anchor left/right based on which side of the circle the label sits on,
  // so it reads outward rather than overlapping the ring.
  const anchor = Math.cos(rad) > 0.15 ? 'start' : Math.cos(rad) < -0.15 ? 'end' : 'middle'
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      dominantBaseline="middle"
      className={compact ? 'text-[9px]' : 'text-[10px]'}
      style={{
        fill: 'var(--ink-muted)',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        opacity: visible ? 1 : 0,
        transition: `opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1) ${delay}s`,
      }}
    >
      {text}
    </text>
  )
}
