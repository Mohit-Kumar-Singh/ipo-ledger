// Status icon for ALLOTTED, adapted from the beach-umbrella-and-rising-money
// illustration. That original has four elements (umbrella, sun lounger, dollar
// coin, trend arrow); all four at the 13-15px this renders at collapse into an
// unreadable smudge, so this keeps the two that actually carry the meaning —
// the umbrella (the scene) and the rising arrow (the gain) — and drops the
// lounger and coin.
//
// Drawn in lucide's stroke idiom (24px box, fill none, currentColor, width 2,
// round caps) rather than octicons' filled-path one, because the source
// illustration is line art and the app already ships lucide-react alongside
// octicons. currentColor means it inherits the badge's own text colour, so it
// tracks light/dark and the badge tint without a second colour to keep in sync.
export function AllottedIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* canopy — arc closed along its base, so it reads as a dome not a hoop */}
      <path d="M2.5 11a5.5 5.5 0 0 1 11 0z" />
      {/* pole */}
      <path d="M8 11v10" />
      {/* ground */}
      <path d="M2 21h20" />
      {/* rising arrow + its head */}
      <path d="M15 10l6-6" />
      <path d="M17 4h4v4" />
    </svg>
  )
}
