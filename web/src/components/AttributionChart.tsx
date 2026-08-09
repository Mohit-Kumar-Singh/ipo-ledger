import { useEffect, useState } from 'react'
import type { IpoAttribution } from '../lib/applicationAttribution'

const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-other']
const SERIES_GLOW_VARS = ['--glow-series-1', '--glow-series-2', '--glow-series-3', '--glow-series-4']

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

// First token of the name only ("Mohit Kumar Singh" -> "Mohit") — the
// legend needs to fit name + count in a two-column grid, and the count
// matters more there than the full name (full name is still shown as the
// tile/page's own heading context elsewhere).
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

// Hand-rolled glassy donut (stacked stroke-dasharray arcs on a shared
// circle, same spirit as every other chart in this app — no library). Went
// through a heavier "3D extruded pie" pass before this; that read as
// clunky/cartoonish rather than elegant, so this goes back to a ring — just
// with a soft drop-shadow for lift, a diagonal glass-sheen highlight, and
// the total app count centered in the hole, none of which the original
// flat donut had either.
export function AttributionChart({ attribution, compact = false }: { attribution: IpoAttribution; compact?: boolean }) {
  const { companyName, totalApplications, slices } = attribution
  const [grown, setGrown] = useState(false)

  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  if (totalApplications === 0 || slices.length === 0) return null

  const size = compact ? 108 : 148
  const strokeWidth = compact ? 16 : 20
  const r = size / 2 - strokeWidth / 2 - 2
  const cx = size / 2
  const cy = size / 2
  const circumference = 2 * Math.PI * r
  const gapPct = Math.min(2, 50 / circumference) // ~1.5px surface gap between segments, in path-length %

  let accPct = 0
  const geometry = slices.map((s) => {
    const rawPct = (s.value / totalApplications) * 100
    const startPct = accPct
    accPct += rawPct
    const visiblePct = Math.max(rawPct - gapPct, 0)
    return { ...s, rawPct, startPct, visiblePct }
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
        <span className="font-mono-ipo shrink-0 text-xs" style={{ color: 'var(--ink-muted)' }}>
          {totalApplications} app{totalApplications === 1 ? '' : 's'}
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-4">
        <div className="relative shrink-0" style={{ width: size, height: size }}>
          {/* Glow keyed off the largest (first, since slices sort desc)
              slice's own color — "this chart's accent," not one fixed hue
              — transparent in light mode. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background: `radial-gradient(circle, var(${SERIES_GLOW_VARS[0]}) 0%, transparent 70%)`,
              filter: 'blur(8px)',
            }}
          />
          <svg
            width={size}
            height={size}
            className="relative shrink-0 overflow-visible"
            style={{ filter: 'drop-shadow(0 3px 8px rgba(0, 0, 0, 0.25))' }}
          >
            <defs>
              {/* Glass sheen — a soft diagonal highlight masked to the ring
                  itself (same donut geometry as strokeWidth below), not a
                  flat overlay square. */}
              <linearGradient id="attribution-sheen" x1="15%" y1="0%" x2="55%" y2="100%">
                <stop offset="0%" stopColor="white" stopOpacity="0.35" />
                <stop offset="45%" stopColor="white" stopOpacity="0" />
              </linearGradient>
            </defs>
            <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth={strokeWidth} opacity={0.4} />
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
            {/* Sheen ring — same radius/width as the data ring, drawn last so
                it sits on top as a highlight rather than tinting the colors
                underneath. */}
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke="url(#attribution-sheen)"
              strokeWidth={strokeWidth}
              style={{ opacity: grown ? 1 : 0, transition: 'opacity 0.5s ease 0.4s' }}
            />
          </svg>
          {/* Total count in the hole — the donut's center was empty dead
              space before; this gives it a job, same way the reference's
              own chart leads with a headline number. */}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span
              className="font-mono-ipo font-bold"
              style={{ color: 'var(--ink-primary)', fontSize: compact ? 18 : 22, lineHeight: 1 }}
            >
              {formatCount(totalApplications)}
            </span>
            {!compact && (
              <span className="text-[10px]" style={{ color: 'var(--ink-muted)' }}>
                apps
              </span>
            )}
          </div>
        </div>

        {/* Two-column legend grid, name + count only — no percentage.
            "Other" folds several small contributors into one slice/color,
            but each of their own counts still gets its own grid entry here
            (same dot color as the slice, dimmed) rather than only a hover
            tooltip, which is easy to miss and unreachable on touch. */}
        {/* Single column, not a 2-col grid — this legend sits beside the
            ring in a fairly narrow tile, and two columns there left names
            truncating hard enough to defeat the earlier "Other" breakdown
            fix (a name goes unreadable again, just via ellipsis instead of
            a hidden bucket). */}
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
          {geometry.flatMap((s, i) => {
            const mainEntry = (
              <div key={s.name} className="flex min-w-0 items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ background: `var(${SERIES_VARS[i] ?? '--series-other'})` }}
                />
                <span className="font-mono-ipo font-medium" style={{ color: 'var(--ink-secondary)', wordBreak: 'break-word' }}>
                  {firstName(s.name)} — {formatCount(s.value)}
                </span>
              </div>
            )
            if (!s.members || s.members.length === 0) return [mainEntry]
            const memberEntries = s.members.map((m) => (
              <div key={m.name} className="flex min-w-0 items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ background: `var(${SERIES_VARS[i] ?? '--series-other'})`, opacity: 0.55 }}
                />
                <span className="font-mono-ipo" style={{ color: 'var(--ink-muted)', wordBreak: 'break-word' }}>
                  {firstName(m.name)} — {formatCount(m.value)}
                </span>
              </div>
            ))
            return [mainEntry, ...memberEntries]
          })}
        </div>
      </div>
    </div>
  )
}
