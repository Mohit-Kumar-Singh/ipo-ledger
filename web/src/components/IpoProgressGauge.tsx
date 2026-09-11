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
  retailIssueSize,
}: {
  applied: number
  total: number
  // Only present when there's something to expand — the "N left" badge is
  // the ONLY click target that opens the card's "accounts yet to apply"
  // panel now (the whole card used to be clickable, which made clicking
  // near the donut/legend/dates to read something also toggle it).
  expanded?: boolean
  onToggleExpanded?: () => void
  // The IPO's own retail issue size (e.g. "₹120 Cr") — shown as a second
  // line under the ratio, inside the arc. Optional/null-able since not
  // every IPO has this on file yet.
  retailIssueSize?: string | null
}) {
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const pct = total > 0 ? Math.min(applied / total, 1) : 0
  const drawnPct = grown ? pct : 0
  // Headline number is now how many are LEFT to apply, not how many already
  // have — "24/44" reads as "24 left out of 44," matching the "N left"
  // button just below it instead of duplicating the applied count from a
  // different angle.
  const left = Math.max(total - applied, 0)
  const animatedLeft = useCountUp(left)

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
        {/* Ratio + label (+ retail size), INSIDE the svg's own coordinate
            space via foreignObject rather than an HTML div overlaid on top
            of it — this arc scales down via the wrapper's `max-width:100%`
            whenever its container is narrower than `size` (the phone-width
            2-column card layout puts two of these side by side, well under
            148px each), and a sibling HTML overlay positioned with plain
            Tailwind px classes does NOT shrink along with it, so the fixed-
            size text kept overlapping the now-smaller ring (real bug, not
            just a tight fit). Text laid out inside the svg scales in lockstep
            with the arc at any container width instead.
            y starts further from the arc's peak than a first pass did (+12
            here, was +6) — the peak is a single point with zero safe width
            either side of it, so starting right there left the top line
            with no real margin; starting lower means the dome has already
            widened out by the time the ratio's own ink begins. The box's
            bottom edge (y=78, the diameter) has nothing drawn on it at
            all — only the curved part of the ring is stroked — so there's
            no matching reason to hold back from extending down that far. */}
        <foreignObject x={cx - 46} y={cy - r + 12} width={92} height={r}>
          {/* No xmlns needed — React creates elements inside a
              <foreignObject> in the HTML namespace by default (it only
              uses the SVG namespace for actual SVG tag names), so a plain
              <div> here already renders correctly as HTML. */}
          <div className="pointer-events-none flex h-full w-full flex-col items-center justify-start text-center">
            <p className="font-mono-ipo text-xl leading-none font-bold" style={{ color: 'var(--ink-primary)' }}>
              {animatedLeft}/{total}
            </p>
            {/* w-full + truncate (not just whitespace-nowrap) — a real
                retail_issue_size can run considerably longer than a short
                test value ("₹369.51 Cr (35.7%)" vs "₹120 Cr"). Centered text
                wider than its box with no width/overflow handling doesn't
                just overflow to one side where you'd at least read the
                start — it overflows evenly on BOTH sides, and foreignObject
                clips at ITS OWN edge, so the visible remainder was a
                mangled slice out of the middle of the string ("ail size:
                ₹369.51 Cr (35" — missing the "Ret" and the closing text).
                An explicit width plus real truncation (ellipsis, one end
                only) degrades to something legible instead. */}
            <p className="mt-1 w-full truncate text-[9px] leading-tight" style={{ color: 'var(--ink-muted)' }}>
              left / active accounts
            </p>
            {retailIssueSize && (
              <p className="w-full truncate text-[9px] leading-tight" style={{ color: 'var(--ink-muted)' }}>
                Retail size: {retailIssueSize}
              </p>
            )}
          </div>
        </foreignObject>
      </svg>
      {/* The only click target for the "accounts yet to apply" panel —
          see IpoDashboardCard/IpoProgressGauge prop comments. Sits below
          the arc now that the ratio/label text above moved up inside it. */}
      {total - applied > 0 && onToggleExpanded && (
        <div className="-mt-1 flex justify-center">
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            className="badge badge-neutral shrink-0 cursor-pointer text-xs"
          >
            {total - applied} left
          </button>
        </div>
      )}
    </div>
  )
}
