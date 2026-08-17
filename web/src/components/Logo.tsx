// Original mark for IPO Ledger — replaces the placeholder "I" square that
// used to live in LoginPage (a stale leftover from an earlier Primer-based
// redesign) and fills a spot AppShell's sidebar never actually had a logo
// in at all. Deliberately NOT a bar chart / checkmark / arrow / generic
// network-node — those read as generic "finance app" clichés. The mark is
// an "IL" monogram (I + L, for IPO Ledger) with one distinguishing feature:
// a short diagonal accent stroke + dot in the upper-right corner, standing
// in for "a data point arriving" — connectivity/movement without a literal
// arrowhead. Self-contained (its own dark badge + gradient), so it reads
// identically in both light and dark theme without needing separate
// light/dark variants.
export function LogoMark({
  size = 32,
  className,
  animated = false,
}: {
  size?: number
  className?: string
  // Loading state — a slow breathing pulse on the whole mark plus the
  // corner accent dot "pinging" outward (same idea as Tailwind's
  // animate-ping), so the brand mark itself communicates "working" instead
  // of a generic spinning ring next to it. Keyframes live in index.css
  // (.logo-pulse / .logo-ping-circle) since Tailwind has no built-in for
  // animating an SVG circle's radius.
  animated?: boolean
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      role="img"
      aria-label="IPO Ledger"
    >
      <defs>
        <linearGradient id="ilBg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0b1220" />
          <stop offset="100%" stopColor="#16213a" />
        </linearGradient>
        {/* Was cyan (#22d3ee) → toned down to a calmer blue, matching the
            same --accent shift in index.css — "too much cyan" feedback. */}
        <linearGradient id="ilMark" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#4f8ff7" />
          <stop offset="100%" stopColor="#34d399" />
        </linearGradient>
      </defs>
      <g className={animated ? 'logo-pulse' : undefined}>
        <rect width="64" height="64" rx="14" fill="url(#ilBg)" />
        {/* "I" */}
        <rect x="17" y="17" width="8" height="30" rx="4" fill="#eef2ff" />
        {/* "L" — vertical stroke + foot */}
        <rect x="31" y="17" width="8" height="30" rx="4" fill="url(#ilMark)" />
        <rect x="31" y="39" width="17" height="8" rx="4" fill="url(#ilMark)" />
        {/* Signature accent — a data point arriving, not an arrowhead */}
        <path d="M45 13 L53 21" stroke="#7db2ff" strokeWidth="3" strokeLinecap="round" />
        {animated && <circle cx="45" cy="13" r="2.4" fill="none" stroke="#7db2ff" strokeWidth="1.5" className="logo-ping-circle" />}
        <circle cx="45" cy="13" r="2.4" fill="#7db2ff" />
      </g>
    </svg>
  )
}

// Full-screen (or inline, via the caller's wrapper) loading state built from
// the brand mark itself — see LogoMark's `animated` prop for what's moving.
export function LogoSpinner({ size = 48 }: { size?: number }) {
  return <LogoMark size={size} animated />
}

export function Logo({
  size = 28,
  className,
  wordmarkClassName,
}: {
  size?: number
  className?: string
  wordmarkClassName?: string
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ''}`}>
      <LogoMark size={size} />
      <span className={`leading-none font-semibold tracking-tight ${wordmarkClassName ?? 'text-base'}`}>
        <span style={{ color: 'var(--ink-primary)' }}>IPO</span>{' '}
        <span style={{ color: 'var(--ink-secondary)', fontWeight: 500 }}>Ledger</span>
      </span>
    </span>
  )
}
