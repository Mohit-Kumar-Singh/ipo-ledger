// Status icon for ALLOTTED, replacing the earlier umbrella design with the
// "shared payout" illustration supplied directly: a rupee coin at the
// center, a broken halo ring around it, and three people connected to it by
// lines — an allotment is money now provisionally split across the account
// holder + funder(s). Every element from the source image is kept (coin,
// symbol, both rings, all three people, all three connector lines); only
// the $ became ₹ and the reference's yellow/blue fill was dropped for
// currentColor, same reasoning as the umbrella version this replaces — it
// has to inherit the badge's own text colour to track light/dark and the
// badge tint without a second colour to keep in sync.
//
// Mixed fill/stroke, not one mode throughout: the ring/coin outline/symbol/
// connector lines are thin strokes (legible at 13-15px without a fill-vs-
// background contrast problem against a currentColor coin fill); the three
// people are small solid silhouettes instead, since a stroke-outlined
// person at this size aliases into nothing recognizable.
export function AllottedIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* halo — two concentric arcs, each open across the bottom third
          where the three connector lines pass through, matching the
          source image's broken-ring look rather than a solid circle
          the lines would visibly cut across. */}
      <path d="M8.15 10.70A5.8 5.8 0 1 1 15.85 10.70" strokeWidth={1} />
      <path d="M9.02 10.13A4.7 4.7 0 1 1 14.98 10.13" strokeWidth={1} />
      {/* coin outline */}
      <circle cx="12" cy="8" r="4.2" />
      {/* rupee mark inside the coin — two bars + descender, the same
          three-stroke shape a $ would have occupied in the source. */}
      <path d="M10.3 6.4h3.4M10.3 7.7h2.9M11.5 7.7l1.8 3.5" strokeWidth={1.1} />
      {/* three connector lines, each starting at the coin edge inside the
          halo's own gap and ending just above its person */}
      <path d="M9.59 11.44 5.7 13.7" />
      <path d="M14.41 11.44 18.3 13.7" />
      <path d="M12 12.2v4.6" />
      {/* left person */}
      <circle cx="5.5" cy="15" r="1.15" fill="currentColor" stroke="none" />
      <rect x="4" y="16.3" width="3" height="3.2" rx="1.5" fill="currentColor" stroke="none" />
      {/* right person */}
      <circle cx="18.5" cy="15" r="1.15" fill="currentColor" stroke="none" />
      <rect x="17" y="16.3" width="3" height="3.2" rx="1.5" fill="currentColor" stroke="none" />
      {/* center person — lower than the other two, same as the source */}
      <circle cx="12" cy="19" r="1.15" fill="currentColor" stroke="none" />
      <rect x="10.5" y="20.3" width="3" height="2.8" rx="1.4" fill="currentColor" stroke="none" />
    </svg>
  )
}
