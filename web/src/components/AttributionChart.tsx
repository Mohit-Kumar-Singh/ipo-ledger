import { useEffect, useState } from 'react'
import type { IpoAttribution } from '../lib/applicationAttribution'

const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-other']

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

interface Dims {
  viewW: number
  viewH: number
  cx: number
  cy: number
  rx: number
  ry: number
  depth: number
}

// Hand-rolled "3D" pie (no charting library, same spirit as every other
// chart in this app) — a tilted ellipse per slice, each with an extruded
// side wall (a second path, offset straight down by `depth`) shaded darker
// via CSS filter, giving the beveled/glossy look of a real 3D pie without
// needing per-color gradient stops computed from the theme's CSS variables.
// Draw order matters: all the side walls first, then all the top faces on
// top of them — since the top faces fully cover the elliptical disc, this
// naturally hides every wall except the sliver that's genuinely part of the
// pie's visible silhouette, with no per-slice front/back visibility math
// needed.
export function AttributionChart({ attribution, compact = false }: { attribution: IpoAttribution; compact?: boolean }) {
  const { companyName, totalApplications, slices } = attribution
  const [grown, setGrown] = useState(false)

  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  if (totalApplications === 0 || slices.length === 0) return null

  const dims: Dims = compact
    ? { viewW: 170, viewH: 132, cx: 85, cy: 54, rx: 60, ry: 34, depth: 15 }
    : { viewW: 220, viewH: 170, cx: 110, cy: 70, rx: 78, ry: 44, depth: 20 }
  const { viewW, viewH, cx, cy, rx, ry, depth } = dims

  let accFrac = 0
  const geometry = slices.map((s) => {
    const frac = s.value / totalApplications
    const startFrac = accFrac
    accFrac += frac
    const endFrac = accFrac
    return { ...s, startFrac, endFrac, pct: frac * 100 }
  })

  function pointAt(frac: number) {
    const angle = -Math.PI / 2 + frac * 2 * Math.PI
    return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }
  }

  // A slice spanning the full 100% (only one contributor total) has
  // identical start/end points — an SVG arc command between two identical
  // points is degenerate and renders as nothing, not a full ellipse. Nudge
  // just shy of a full turn so the arc has a real (imperceptibly small)
  // sweep instead of collapsing.
  function endPointFor(startFrac: number, endFrac: number) {
    return pointAt(Math.min(endFrac, startFrac + 0.9999))
  }

  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p
          className={`font-display truncate ${compact ? 'text-sm font-medium' : 'text-sm font-semibold'}`}
          style={{ color: 'var(--ink-primary)' }}
        >
          {companyName}
        </p>
        <span className="font-display shrink-0 text-xs" style={{ color: 'var(--ink-muted)' }}>
          {totalApplications} app{totalApplications === 1 ? '' : 's'}
        </span>
      </div>

      <svg viewBox={`0 0 ${viewW} ${viewH}`} className="mx-auto block w-full" style={{ maxWidth: viewW }}>
        {/* Side walls, drawn first so the top faces (below) paint over the
            part of each that isn't part of the pie's actual silhouette. */}
        <g>
          {geometry.map((g, i) => {
            // A near-zero slice has no visible wall and an emptyish arc —
            // skip it rather than emit a degenerate/NaN path.
            if (g.pct <= 0) return null
            const startFrac = grown ? g.startFrac : 0
            const endFrac = grown ? g.endFrac : 0
            const p0 = pointAt(startFrac)
            const p1 = grown ? endPointFor(startFrac, endFrac) : pointAt(endFrac)
            const largeArc = g.endFrac - g.startFrac > 0.5 ? 1 : 0
            const d = [
              `M ${p0.x} ${p0.y}`,
              `A ${rx} ${ry} 0 ${largeArc} 1 ${p1.x} ${p1.y}`,
              `L ${p1.x} ${p1.y + depth}`,
              `A ${rx} ${ry} 0 ${largeArc} 0 ${p0.x} ${p0.y + depth}`,
              'Z',
            ].join(' ')
            return (
              <path
                key={g.name}
                d={d}
                fill={`var(${SERIES_VARS[i] ?? '--series-other'})`}
                stroke="var(--page)"
                strokeWidth={1}
                style={{
                  filter: 'brightness(0.62)',
                  opacity: grown ? 1 : 0,
                  transition: `opacity 0.5s cubic-bezier(0.16, 1, 0.3, 1) ${i * 0.06}s`,
                }}
              />
            )
          })}
        </g>

        {/* Top faces — the flat ellipse-slice wedges, brightened slightly
            so they read as the "lit" face against the darker walls below. */}
        <g>
          {geometry.map((g, i) => {
            if (g.pct <= 0) return null
            const startFrac = grown ? g.startFrac : 0
            const endFrac = grown ? g.endFrac : 0
            const p0 = pointAt(startFrac)
            const p1 = grown ? endPointFor(startFrac, endFrac) : pointAt(endFrac)
            const largeArc = endFrac - startFrac > 0.5 ? 1 : 0
            const d = `M ${cx} ${cy} L ${p0.x} ${p0.y} A ${rx} ${ry} 0 ${largeArc} 1 ${p1.x} ${p1.y} Z`
            return (
              <path
                key={g.name}
                d={d}
                fill={`var(${SERIES_VARS[i] ?? '--series-other'})`}
                stroke="var(--page)"
                strokeWidth={1}
                style={{
                  filter: 'brightness(1.08)',
                  transition: `d 0.6s cubic-bezier(0.16, 1, 0.3, 1) ${i * 0.06}s`,
                }}
              />
            )
          })}
        </g>

        {/* Glossy highlight — a soft white sheen over the upper-left of the
            disc, the same trick that sells the "lit from above" look in the
            reference. Pure decoration (aria-hidden via pointer-events:none
            is implicit for SVG shapes with no interaction handlers). */}
        <ellipse
          cx={cx - rx * 0.28}
          cy={cy - ry * 0.35}
          rx={rx * 0.55}
          ry={ry * 0.4}
          fill="white"
          opacity={0.1}
          style={{ mixBlendMode: 'overlay' }}
        />
      </svg>

      {/* Two-column legend grid, name + count only (no percentage) — matches
          the reference. "Other" folds several small contributors into one
          slice/color, but each of their own counts still gets its own grid
          entry here (same dot color as the slice) rather than only a hover
          tooltip, which is easy to miss and unreachable on touch. */}
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        {geometry.flatMap((s, i) => {
          const mainEntry = (
            <div key={s.name} className="flex min-w-0 items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: `var(${SERIES_VARS[i] ?? '--series-other'})` }}
              />
              <span className="font-display truncate font-medium" style={{ color: 'var(--ink-secondary)' }}>
                {firstName(s.name)} — {formatCount(s.value)}
              </span>
            </div>
          )
          if (!s.members || s.members.length === 0) return [mainEntry]
          const memberEntries = s.members.map((m) => (
            <div key={m.name} className="flex min-w-0 items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: `var(${SERIES_VARS[i] ?? '--series-other'})`, opacity: 0.6 }}
              />
              <span className="font-display truncate" style={{ color: 'var(--ink-muted)' }}>
                {firstName(m.name)} — {formatCount(m.value)}
              </span>
            </div>
          ))
          return [mainEntry, ...memberEntries]
        })}
      </div>
    </div>
  )
}
