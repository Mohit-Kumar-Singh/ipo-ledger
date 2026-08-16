import { useEffect, useState } from 'react'
import type { IpoAttribution } from '../lib/applicationAttribution'

// Cycled via modulo, not capped — every funder gets a real slice now (no
// "Other" bucket to absorb anyone past a fixed count), so with more than 4
// contributors on one IPO the palette repeats rather than running out.
const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-other']
const SERIES_GLOW_VARS = ['--glow-series-1', '--glow-series-2', '--glow-series-3', '--glow-series-4']

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}


// Hand-rolled glassy donut (stacked stroke-dasharray arcs on a shared
// circle, same spirit as every other chart in this app — no library). Went
// through a heavier "3D extruded pie" pass before this; that read as
// clunky/cartoonish rather than elegant, so this goes back to a ring — just
// with a soft drop-shadow for lift, a diagonal glass-sheen highlight, and
// the total app count centered in the hole, none of which the original
// flat donut had either.
export function AttributionChart({
  attribution,
  compact = false,
  hideHeader = false,
}: {
  attribution: IpoAttribution
  compact?: boolean
  // The unified Dashboard IPO card (IpoDashboardCard) already shows the
  // company name in its own header — without this, that name (and the "N
  // apps" count) rendered a second time immediately above the donut.
  // ProfilePage's standalone usage keeps the header (default false).
  hideHeader?: boolean
}) {
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
  // A tiny dash length for the two decorative end-cap "bumps" below — short
  // enough to read as a rounded point, not a visible sliver of its own.
  const capPct = Math.min(0.5, gapPct / 4)

  // Slices sum to exactly 100% (every application is accounted for), so the
  // ring has exactly ONE real seam — where the last slice's end meets the
  // first slice's start again. That's the only place stroke-linecap="round"
  // and the small gap belong; every OTHER slice-to-slice boundary is two
  // different colors that should meet at one clean flat point, not each
  // show its own rounded cap with a gap on both sides of it (what a
  // uniform "round + gap on every slice" treatment used to draw). So: every
  // slice is drawn full-length (no gap) with a flat (butt) cap, EXCEPT the
  // last slice is shortened by gapPct at its own end — the one point that
  // needs a gap at all — and two small round-capped "cap" arcs are layered
  // on top afterward, exactly at that one seam, to recreate a rounded tip
  // there without rounding anything else.
  let accPct = 0
  const geometry = slices.map((s, i) => {
    const rawPct = (s.value / totalApplications) * 100
    const startPct = accPct
    accPct += rawPct
    const isLast = i === slices.length - 1
    const visiblePct = isLast ? Math.max(rawPct - gapPct, 0) : rawPct
    return { ...s, rawPct, startPct, visiblePct }
  })
  const seamEndPct = Math.max(100 - gapPct, 0)

  return (
    <div className="min-w-0">
      {!hideHeader && (
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
      )}

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
                  stroke={`var(${SERIES_VARS[i % SERIES_VARS.length]})`}
                  strokeWidth={strokeWidth}
                  strokeLinecap="butt"
                  pathLength={100}
                  strokeDasharray={grown ? `${g.visiblePct} ${100 - g.visiblePct}` : '0 100'}
                  strokeDashoffset={-g.startPct}
                  style={{
                    transition: `stroke-dasharray 0.6s cubic-bezier(0.16, 1, 0.3, 1) ${i * 0.08}s`,
                  }}
                />
              ))}
              {/* The ring's one real seam — first slice's start and last
                  slice's end — gets its rounded tip from these two tiny
                  round-capped arcs layered on top, not from the slices
                  themselves (which are flat/butt everywhere so internal
                  color-to-color boundaries stay clean). */}
              {grown && geometry.length > 0 && (
                <>
                  <circle
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill="none"
                    stroke={`var(${SERIES_VARS[0]})`}
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    pathLength={100}
                    strokeDasharray={`${capPct} ${100 - capPct}`}
                    strokeDashoffset={0}
                  />
                  <circle
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill="none"
                    stroke={`var(${SERIES_VARS[(geometry.length - 1) % SERIES_VARS.length]})`}
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    pathLength={100}
                    strokeDasharray={`${capPct} ${100 - capPct}`}
                    strokeDashoffset={-seamEndPct}
                  />
                </>
              )}
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

        {/* Single column, not a 2-col grid — narrow tile, and two columns
            there left names truncating hard. Every funder gets a real
            legend line now — no "Other" bucket, so no separate dimmed
            "member" sub-entries either; this is just the full slice list. */}
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
          {geometry.map((s, i) => (
            <div key={s.name} className="flex min-w-0 items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: `var(${SERIES_VARS[i % SERIES_VARS.length]})` }}
              />
              <span className="font-mono-ipo font-medium" style={{ color: 'var(--ink-secondary)', wordBreak: 'break-word' }}>
                {s.name} — {formatCount(s.value)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
