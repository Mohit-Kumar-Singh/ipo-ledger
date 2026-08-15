// A real floating card on hover/focus, not a plain-text browser tooltip —
// tinted by a tone, with a little pop-in so it feels like part of the UI
// rather than a bolted-on afterthought. CSS-only (group-hover), no JS
// positioning library. Originally built for Dashboard's stat-tile panels,
// now the one hover-card implementation the rest of the portal reuses too
// (see InfoTooltip below) instead of plain `title=` attributes.
import type { ReactNode } from 'react'
import { InfoIcon } from '@primer/octicons-react'

export type HoverCardTone = 'info' | 'warning' | 'good' | 'critical'

const TONE_COLOR: Record<HoverCardTone, string> = {
  info: 'var(--accent)',
  warning: 'var(--warning)',
  good: 'var(--good)',
  critical: 'var(--critical)',
}

export function HoverCard({
  children,
  panel,
  tone = 'info',
  align = 'left',
}: {
  children: ReactNode
  panel: ReactNode
  tone?: HoverCardTone
  // 'left' anchors the panel's LEFT edge to the trigger and grows rightward
  // (the natural default for an inline icon near the left/middle of the
  // page); 'right' anchors the panel's right edge and grows leftward (what
  // Dashboard's stat tiles need — a centered panel ran off the right edge
  // of the viewport for the rightmost tile in a row).
  align?: 'left' | 'right'
}) {
  const toneColor = TONE_COLOR[tone]
  return (
    // A plain div, not inline — works equally as a grid cell's full-size
    // trigger (Dashboard's stat tiles) and as a small flex-item trigger
    // (an (i) icon inside a heading row), since a block-level child inside
    // a flex container still only takes up its content's width either way.
    <div className="group relative">
      {children}
      <div
        className={`pointer-events-none absolute top-full z-30 mt-2 w-72 max-w-[88vw] translate-y-1 opacity-0 transition-all duration-150 ease-out group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100 ${
          align === 'right' ? 'right-0' : 'left-0'
        }`}
      >
        <div
          className="overflow-hidden rounded-xl border p-3 text-left text-xs shadow-2xl backdrop-blur-md"
          style={{
            borderColor: toneColor,
            borderTopWidth: '2px',
            background: 'var(--surface)',
            maxHeight: '18rem',
            overflowY: 'auto',
            boxShadow: `0 12px 32px -8px ${toneColor}55, 0 4px 12px -2px rgba(0,0,0,0.25)`,
          }}
        >
          {panel}
        </div>
      </div>
    </div>
  )
}

// The (i)-icon explanatory tooltip used throughout the portal (Profile,
// Applications, Notifications, IpojiSyncPanel) — same rich card as
// Dashboard's stat tiles, replacing a plain `title=` attribute (no styling,
// truncates awkwardly on long copy, and pairs oddly with the icon since the
// browser's own help cursor duplicates what the icon already signals).
export function InfoTooltip({ text, tone = 'info' }: { text: string; tone?: HoverCardTone }) {
  return (
    <HoverCard
      tone={tone}
      panel={
        // pre-line, not the default — a couple of these tooltips (the ipoji
        // sync script's usage instructions) are multi-paragraph with real
        // \n line breaks in the source string; without this they'd collapse
        // into one unreadable run-on line the way plain JSX text always does.
        <p style={{ color: 'var(--ink-secondary)', whiteSpace: 'pre-line' }}>{text}</p>
      }
    >
      {/* cursor: default, not 'help' — the (i) icon already signals "more
          info," a second question-mark cursor on top of it was redundant. */}
      <span style={{ display: 'inline-flex', cursor: 'default' }}>
        <InfoIcon size={12} fill="var(--ink-muted)" />
      </span>
    </HoverCard>
  )
}
