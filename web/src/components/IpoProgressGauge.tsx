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
  expanded,
  onToggleExpanded,
}: {
  companyName: string
  startDate: string
  endDate: string
  applied: number
  total: number
  gmpNotes: string | null
  remainingHolderNames: string[]
  expanded: boolean
  onToggleExpanded: () => void
}) {
  const [grown, setGrown] = useState(false)
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
    // flex-col below sm (640px): side-by-side only has room once the left
    // column (204px) + expanded side panel (210px) + gaps/padding actually
    // fit the viewport — on a phone that's ~460px of content in a 375px
    // window, clipping the panel right off-screen. Stacking instead means
    // each piece only has to fit on its own.
    <div className="glass-card stagger-item flex flex-col gap-4 p-4 sm:flex-row">
      {/* Fixed width on sm+, not flex-1: if this grew/shrank as the side
          panel's width animates, the gauge (which scales to its container)
          would visibly resize mid-animation on top of the tile widening —
          two motions fighting each other instead of one clean one. Full
          width when stacked (below sm) since there's no sibling beside it
          to share the row with there. */}
      <div className="w-full sm:w-[204px] sm:shrink-0">
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
            onClick={onToggleExpanded}
            disabled={accountsLeft === 0}
            aria-expanded={expanded}
            className="badge badge-neutral shrink-0 text-xs disabled:cursor-default"
            style={{ cursor: accountsLeft > 0 ? 'pointer' : undefined }}
          >
            {accountsLeft} left
          </button>
        </div>

        <div className="relative">
          {/* Soft radial glow behind the ring, in the gauge's own accent
              color (--glow-good, same token the arc itself is drawn in) —
              transparent in light mode, so this is a no-op there. The
              glow, not a box-shadow, is the depth cue (KOVAREX retheme). */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(circle at 50% 55%, var(--glow-good) 0%, transparent 68%)', filter: 'blur(6px)' }}
          />
          <svg viewBox={`0 0 ${size} ${size / 2 + 16}`} className="relative w-full">
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
        </div>

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
      </div>

      {/* Side panel, not a below-the-fold section: max-width 0->210px, timed
          with the same 0.35s/easing as the parent's flex-basis transition
          (DashboardPage) so the tile widens and the panel reveals as one
          continuous motion instead of a snap-then-fade. max-height is
          collapsed alongside max-width — without it, this panel's own fixed-
          width (210px) content still lays out at its natural height even
          while visually clipped to 0 width, so cards with more "yet to
          apply" names (a taller capped list) rendered taller than cards with
          fewer names, even collapsed. Both dimensions must close to 0 for
          every collapsed card to actually be the same size. */}
      <div
        className="shrink-0 overflow-hidden"
        style={{
          maxWidth: expanded ? 210 : 0,
          maxHeight: expanded ? 400 : 0,
          transition: 'max-width 0.35s cubic-bezier(0.16, 1, 0.3, 1), max-height 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div className="w-[210px] border-l pl-3" style={{ borderColor: 'var(--border)' }}>
          <p className="mb-1 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
            Accounts yet to apply ({remainingHolderNames.length})
          </p>
          <ul className="max-h-64 overflow-y-auto">
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
  )
}
