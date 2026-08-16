import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { IpoAttribution } from '../lib/applicationAttribution'

// Cycled via modulo, not capped — every funder gets a real slice now (no
// "Other" bucket to absorb anyone past a fixed count), so with more than 4
// contributors on one IPO the palette repeats rather than running out.
const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-other']

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

// One quarter-circle fillet, radius r, connecting the two tangent points on
// either side of a corner where a radial edge meets a circular arc (those
// two edges are always perpendicular at that corner, which is what makes
// this solvable as a plain quarter circle rather than needing a general
// fillet formula). `from`/`to` are points already known to lie exactly on
// the circle of radius r around `center` — this only figures out which of
// the two ways around to sweep (the short, ~90° way).
function shortArc(ctx: CanvasRenderingContext2D, center: { x: number; y: number }, r: number, from: { x: number; y: number }, to: { x: number; y: number }) {
  const a0 = Math.atan2(from.y - center.y, from.x - center.x)
  const a1 = Math.atan2(to.y - center.y, to.x - center.x)
  let diff = a1 - a0
  while (diff > Math.PI) diff -= 2 * Math.PI
  while (diff <= -Math.PI) diff += 2 * Math.PI
  ctx.arc(center.x, center.y, r, a0, a0 + diff, diff < 0)
}

// One donut "petal" — an annular sector with all four corners rounded by
// `cornerR`, same shape Chart.js's `borderRadius` produces on a doughnut
// segment. Traced as: fillet (outer-start) → outer arc → fillet
// (outer-end) → straight radial edge → fillet (inner-end) → inner arc
// (reverse) → fillet (inner-start) → straight radial edge back to start.
// Each fillet is a quarter circle since a radial edge always meets a
// circular arc at 90° — see shortArc above.
function tracePetal(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngle: number,
  endAngle: number,
  cornerR: number,
) {
  const sweep = endAngle - startAngle
  const r = Math.max(0, Math.min(cornerR, (outerR - innerR) / 2, (sweep * innerR) / 2 - 0.01))
  if (r < 0.5 || sweep <= 0) {
    ctx.beginPath()
    ctx.arc(cx, cy, outerR, startAngle, endAngle)
    ctx.arc(cx, cy, innerR, endAngle, startAngle, true)
    ctx.closePath()
    return
  }

  const cosS = Math.cos(startAngle), sinS = Math.sin(startAngle)
  const cosE = Math.cos(endAngle), sinE = Math.sin(endAngle)
  const outerOffset = r / outerR
  const innerOffset = r / innerR

  const pt = (radius: number, angle: number) => ({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) })
  const add = (p: { x: number; y: number }, dx: { x: number; y: number }, dy: { x: number; y: number }) => ({
    x: p.x + r * dx.x + r * dy.x,
    y: p.y + r * dx.y + r * dy.y,
  })

  const osCenter = add(pt(outerR, startAngle), { x: -sinS, y: cosS }, { x: -cosS, y: -sinS })
  const ptA = pt(outerR - r, startAngle)
  const ptB = pt(outerR, startAngle + outerOffset)

  const oeCenter = add(pt(outerR, endAngle), { x: sinE, y: -cosE }, { x: -cosE, y: -sinE })
  const ptC = pt(outerR, endAngle - outerOffset)
  const ptD = pt(outerR - r, endAngle)

  const ieCenter = add(pt(innerR, endAngle), { x: sinE, y: -cosE }, { x: cosE, y: sinE })
  const ptE = pt(innerR + r, endAngle)
  const ptF = pt(innerR, endAngle - innerOffset)

  const isCenter = add(pt(innerR, startAngle), { x: -sinS, y: cosS }, { x: cosS, y: sinS })
  const ptG = pt(innerR, startAngle + innerOffset)
  const ptH = pt(innerR + r, startAngle)

  ctx.beginPath()
  ctx.moveTo(ptA.x, ptA.y)
  shortArc(ctx, osCenter, r, ptA, ptB)
  ctx.arc(cx, cy, outerR, startAngle + outerOffset, endAngle - outerOffset)
  shortArc(ctx, oeCenter, r, ptC, ptD)
  ctx.lineTo(ptE.x, ptE.y)
  shortArc(ctx, ieCenter, r, ptE, ptF)
  ctx.arc(cx, cy, innerR, endAngle - innerOffset, startAngle + innerOffset, true)
  shortArc(ctx, isCenter, r, ptG, ptH)
  ctx.closePath()
}

interface SliceGeom {
  name: string
  value: number
  color: string
  startAngle: number
  endAngle: number
}

// Canvas, not SVG — matching the reference's exact corner-rounded, gapped
// segment shape (Chart.js's borderRadius + spacing on a doughnut) needs a
// real annular-sector path with quarter-circle fillets at all four corners
// (tracePetal above); SVG's stroke-linecap only offers a full round cap
// (radius = half the stroke width) or none, which can't express a small,
// fixed corner radius independent of ring thickness. Still zero
// dependencies — canvas is a native browser API, not a charting library.
export function AttributionChart({
  attribution,
  compact = false,
  hideHeader = false,
  hideLegend = false,
}: {
  attribution: IpoAttribution
  compact?: boolean
  // The unified Dashboard IPO card (IpoDashboardCard) already shows the
  // company name in its own header — without this, that name (and the "N
  // apps" count) rendered a second time immediately above the donut.
  // ProfilePage's standalone usage keeps the header (default false).
  hideHeader?: boolean
  // Chart-only, no legend column — IpoDashboardCard's phone quadrant
  // layout renders the legend as its own separate grid cell (via
  // AttributionLegend below), not beside the chart, so it needs the chart
  // alone here instead of the combined side-by-side unit.
  hideLegend?: boolean
}) {
  const { companyName, totalApplications, slices } = attribution
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [grown, setGrown] = useState(false)
  const [hover, setHover] = useState<{ x: number; y: number; name: string; value: number; color: string } | null>(null)

  const size = compact ? 108 : 148
  const strokeWidth = compact ? 16 : 20
  const midR = size / 2 - strokeWidth / 2 - 2
  const outerR = midR + strokeWidth / 2
  const innerR = midR - strokeWidth / 2
  const cx = size / 2
  const cy = size / 2
  // Reference uses borderRadius 6 / spacing 3 on a 220px chart — scaled
  // down proportionally for this component's smaller sizes.
  const cornerR = (compact ? 4 : 5) * (size / 220)
  const gapAngle = ((compact ? 2.5 : 3) * (size / 220)) / midR

  let acc = -Math.PI / 2 // start at the top, same as the rest of this app's charts
  const geometry: SliceGeom[] = slices.map((s, i) => {
    const sweep = totalApplications > 0 ? (s.value / totalApplications) * Math.PI * 2 : 0
    const rawStart = acc
    acc += sweep
    const startAngle = rawStart + gapAngle / 2
    const endAngle = Math.max(acc - gapAngle / 2, startAngle)
    return { name: s.name, value: s.value, color: `var(${SERIES_VARS[i % SERIES_VARS.length]})`, startAngle, endAngle }
  })

  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || totalApplications === 0 || slices.length === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)

    const computed = getComputedStyle(canvas)
    for (const g of geometry) {
      const resolved = g.color.startsWith('var(') ? computed.getPropertyValue(g.color.slice(4, -1)).trim() : g.color
      ctx.fillStyle = resolved || '#8a8f99'
      ctx.globalAlpha = hover && hover.name !== g.name ? 0.55 : 1
      tracePetal(ctx, cx, cy, outerR, innerR, g.startAngle, g.endAngle, cornerR)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attribution, size, compact, hover])

  if (totalApplications === 0 || slices.length === 0) return null

  function handleMove(e: ReactMouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left - cx
    const y = e.clientY - rect.top - cy
    const dist = Math.hypot(x, y)
    if (dist < innerR - 3 || dist > outerR + 3) {
      if (hover) setHover(null)
      return
    }
    let angle = Math.atan2(y, x)
    while (angle < -Math.PI / 2) angle += Math.PI * 2
    while (angle > (3 * Math.PI) / 2) angle -= Math.PI * 2
    const match = geometry.find((g) => angle >= g.startAngle && angle <= g.endAngle)
    if (!match) {
      if (hover) setHover(null)
      return
    }
    const computed = getComputedStyle(e.currentTarget)
    const resolved = match.color.startsWith('var(') ? computed.getPropertyValue(match.color.slice(4, -1)).trim() : match.color
    setHover({ x: e.clientX, y: e.clientY, name: match.name, value: match.value, color: resolved })
  }

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
        <div ref={wrapRef} className="relative shrink-0" style={{ width: size, height: size, opacity: grown ? 1 : 0, transform: grown ? 'scale(1)' : 'scale(0.85)', transition: 'opacity 0.35s ease, transform 0.35s cubic-bezier(0.16, 1, 0.3, 1)' }}>
          {/* Flat, matte segments — no glow/gloss/shadow, matching the
              reference's plain solid-color look exactly. */}
          <canvas
            ref={canvasRef}
            width={size}
            height={size}
            className="relative shrink-0"
            onMouseMove={handleMove}
            onMouseLeave={() => setHover(null)}
          />
          {hover && (
            <div
              className="pointer-events-none fixed z-10 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium shadow-lg"
              style={{
                left: hover.x,
                top: hover.y,
                transform: 'translate(-50%, -130%)',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                color: 'var(--ink-primary)',
                whiteSpace: 'nowrap',
              }}
            >
              <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: hover.color }} />
              {hover.name}: {formatCount(hover.value)}
            </div>
          )}
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
        {!hideLegend && (
          <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
            {geometry.map((s) => (
              <div key={s.name} className="flex min-w-0 items-center gap-1.5">
                <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                <span className="font-mono-ipo font-medium" style={{ color: 'var(--ink-secondary)', wordBreak: 'break-word' }}>
                  {s.name} — {formatCount(s.value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// The legend alone, no chart — IpoDashboardCard's phone quadrant layout
// (funder list top-left, chart top-right) needs these as two independent
// grid cells instead of the combined side-by-side unit AttributionChart
// renders by default. Same color-index/name/count logic as the legend
// column above, just without the arc geometry a standalone legend has no
// use for.
export function AttributionLegend({
  attribution,
  className = '',
  firstNameOnly = false,
}: {
  attribution: IpoAttribution
  className?: string
  // Dashboard's phone quadrant column is too narrow for a full "Mohit Kumar
  // Singh" — it wraps to a second line and blows out the row height. First
  // name only keeps every legend line to one row on a phone-width column.
  firstNameOnly?: boolean
}) {
  const { totalApplications, slices } = attribution
  if (totalApplications === 0 || slices.length === 0) return null
  // More than 5 funders no longer fits the quadrant's fixed height — scroll
  // instead of pushing the row (and the whole card) taller.
  const scrollable = slices.length > 5
  return (
    <div
      className={`flex min-w-0 flex-col gap-1 text-xs ${scrollable ? 'max-h-24 overflow-y-auto' : ''} ${className}`}
    >
      {slices.map((s, i) => (
        <div key={s.name} className="flex min-w-0 items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ background: `var(${SERIES_VARS[i % SERIES_VARS.length]})` }}
          />
          <span
            className="font-mono-ipo truncate font-medium"
            style={{ color: 'var(--ink-secondary)' }}
            title={`${s.name} — ${formatCount(s.value)}`}
          >
            {firstNameOnly ? s.name.split(' ')[0] : s.name} — {formatCount(s.value)}
          </span>
        </div>
      ))}
    </div>
  )
}
