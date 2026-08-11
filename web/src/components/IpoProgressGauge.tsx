import { useEffect, useState } from 'react'
import { useCountUp } from '../lib/useCountUp'

// Hand-rolled half-donut gauge (SVG arc via pathLength/dasharray) — no
// charting library, same spirit as every other chart in this app. Fill
// grows with `applied`, so it visibly advances as more accounts apply, and
// draws in from zero on mount (render the "before" state first, flip to
// the real value a frame later so the CSS transition animates it).
//
// Bare ring + count only — no card wrapper, no company name/dates/GMP
// text, no "accounts yet to apply" panel. Those used to live inside this
// component, but with only one consumer (DashboardPage's IpoDashboardCard,
// which now owns the whole per-IPO card: header, both charts side by side,
// and the shared expand panel), keeping them here just duplicated what the
// card already renders itself.
export function IpoProgressGauge({
  applied,
  total,
  expanded,
  onToggleExpanded,
}: {
  applied: number
  total: number
  // Only present when there's something to expand — the "N left" badge is
  // the ONLY click target that opens the card's "accounts yet to apply"
  // panel now (the whole card used to be clickable, which made clicking
  // near the donut/legend/dates to read something also toggle it).
  expanded?: boolean
  onToggleExpanded?: () => void
}) {
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const pct = total > 0 ? Math.min(applied / total, 1) : 0
  const drawnPct = grown ? pct : 0
  const animatedApplied = useCountUp(applied)

  const size = 148
  const r = 62
  const strokeWidth = 12
  const cx = size / 2
  const cy = size / 2 + 4
  const arcPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`
  const dotAngle = Math.PI * (1 - drawnPct)
  const dotX = cx + r * Math.cos(dotAngle)
  const dotY = cy - r * Math.sin(dotAngle)

  return (
    <div className="relative mx-auto shrink-0" style={{ width: size, maxWidth: '100%' }}>
      {/* Soft radial glow behind the ring, in the gauge's own accent color
          (--glow-good, same token the arc itself is drawn in) — transparent
          in light mode. The glow, not a box-shadow, is the depth cue
          (KOVAREX retheme). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(circle at 50% 60%, var(--glow-good) 0%, transparent 68%)', filter: 'blur(8px)' }}
      />
      <svg viewBox={`0 0 ${size} ${size / 2 + 16}`} className="relative w-full">
        <path d={arcPath} fill="none" stroke="var(--border)" strokeWidth={strokeWidth} strokeLinecap="round" opacity={0.5} />
        <path
          d={arcPath}
          fill="none"
          stroke="var(--good)"
          strokeWidth={strokeWidth}
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
        <p className="font-mono-ipo text-xl font-bold" style={{ color: 'var(--ink-primary)' }}>
          {animatedApplied}/{total}
        </p>
        <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
          applied / active accounts
        </p>
        {/* Was its own badge up in the card header — moved down here, right
            under the ratio it's derived from, since "accounts left" is a
            reading of this same ring, not a separate fact about the card.
            The only click target for the "accounts yet to apply" panel —
            see IpoDashboardCard/IpoProgressGauge prop comments. */}
        {total - applied > 0 && onToggleExpanded && (
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            className="badge badge-neutral mt-1.5 inline-block cursor-pointer text-xs"
          >
            {total - applied} left
          </button>
        )}
      </div>
    </div>
  )
}
