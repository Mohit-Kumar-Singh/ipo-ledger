import { useId, useRef, useState, type MouseEvent } from 'react'

export interface AreaChartPoint {
  label: string
  value: number
}

const W = 600

// Lightweight hand-rolled SVG area chart with a hover tooltip — deliberately
// dependency-free (no recharts/d3) to keep this bundle-conscious app lean.
// viewBox is a fixed internal coordinate space; preserveAspectRatio="none"
// lets it stretch to the container width while vector-effect keeps stroke
// width constant despite that non-uniform scaling.
export function AreaChart({
  data,
  colorVar = '--accent',
  height = 200,
}: {
  data: AreaChartPoint[]
  colorVar?: string
  height?: number
}) {
  const gradientId = useId()
  const svgRef = useRef<SVGSVGElement>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  const padY = 16
  const max = Math.max(1, ...data.map((d) => d.value))
  const min = Math.min(0, ...data.map((d) => d.value))
  const range = max - min || 1
  const stepX = data.length > 1 ? W / (data.length - 1) : 0

  const xAt = (i: number) => (data.length > 1 ? i * stepX : W / 2)
  const yAt = (v: number) => padY + (1 - (v - min) / range) * (height - padY * 2)

  const linePath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(d.value)}`).join(' ')
  const areaPath = data.length > 0 ? `${linePath} L ${xAt(data.length - 1)} ${height} L ${xAt(0)} ${height} Z` : ''

  function handleMove(e: MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || data.length === 0) return
    const relX = ((e.clientX - rect.left) / rect.width) * W
    const idx = Math.round(relX / (stepX || 1))
    setHoverIndex(Math.min(data.length - 1, Math.max(0, idx)))
  }

  const hovered = hoverIndex != null ? data[hoverIndex] : null

  if (data.length === 0) return null

  return (
    <div className="relative" style={{ height }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
        className="overflow-visible"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={`var(${colorVar})`} stopOpacity="0.35" />
            <stop offset="100%" stopColor={`var(${colorVar})`} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path
          d={linePath}
          fill="none"
          stroke={`var(${colorVar})`}
          strokeWidth={2.5}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {hoverIndex != null && (
          <>
            <line
              x1={xAt(hoverIndex)}
              x2={xAt(hoverIndex)}
              y1={0}
              y2={height}
              stroke="var(--border-strong)"
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={xAt(hoverIndex)}
              cy={yAt(data[hoverIndex].value)}
              r={5}
              fill={`var(${colorVar})`}
              stroke="var(--surface)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>

      {hovered && hoverIndex != null && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-lg border px-2.5 py-1.5 text-xs whitespace-nowrap"
          style={{
            left: `${(xAt(hoverIndex) / W) * 100}%`,
            top: `${(yAt(hovered.value) / height) * 100}%`,
            marginTop: '-10px',
            background: 'var(--surface)',
            borderColor: 'var(--border-strong)',
            boxShadow: 'var(--shadow-md)',
            color: 'var(--ink-primary)',
          }}
        >
          <span className="font-semibold">{hovered.value}</span>{' '}
          <span style={{ color: 'var(--ink-muted)' }}>{hovered.label}</span>
        </div>
      )}

      <div className="mt-1 flex justify-between text-xs" style={{ color: 'var(--ink-muted)' }}>
        {data.map((d, i) => (
          <span key={i}>{d.label}</span>
        ))}
      </div>
    </div>
  )
}
