import { useEffect, useState } from 'react'
import { istTimeMs } from '../lib/ipoStatus'

export interface IpoTimelineMilestone {
  date: string | null
  label: string
  // Trailing "*" on the label + dimmer treatment for a date that's a
  // schedule estimate (allotment/listing) rather than a locked-in fact
  // (open/close) — purely cosmetic, defaults to false.
  estimated?: boolean
}

interface IpoTimelineProps {
  // Data-driven, not fixed 4-date props — segment count and dot count both
  // come from this array's length, so a caller with more or fewer
  // milestones (or a totally different kind of timeline) doesn't need a
  // second component.
  milestones: IpoTimelineMilestone[]
}

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return 'TBA'
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  return `${ordinal(d)} ${month}`
}

// Each milestone lands at its own real IST time of day, not a blanket
// midnight — matches how these actually happen in practice: bidding opens
// at 10am, cuts off at 4:50pm IST (the same cutoff isOpenForBidding/
// hasBiddingClosed already enforce elsewhere), allotment is typically
// finalized around midday, and listing/trading opens at 10am same as the
// exchanges' own market open. Label-matched, not a positional assumption —
// works whether "Close" is milestone 1 of 4 or anywhere else in a
// differently-shaped milestones array; anything with an unrecognized label
// falls back to midnight IST.
const MILESTONE_IST_TIME: Record<string, { hour: number; minute: number }> = {
  Open: { hour: 10, minute: 0 },
  Close: { hour: 16, minute: 50 },
  Allotment: { hour: 12, minute: 0 },
  Listing: { hour: 10, minute: 0 },
}

function milestoneInstantMs(label: string, dateIso: string): number {
  const t = MILESTONE_IST_TIME[label] ?? { hour: 0, minute: 0 }
  return istTimeMs(dateIso, t.hour, t.minute)
}

// 12h, not a per-second/per-minute tick — the underlying milestone dates
// only change daily at most, so anything finer than "twice a day" is
// spending re-renders on a value that can't have meaningfully moved.
// Recomputing on an interval (not just once on mount) is what makes the
// segment actually creep forward across a page left open, rather than
// freezing at whatever fraction it happened to load at.
const RECOMPUTE_INTERVAL_MS = 12 * 60 * 60 * 1000

// Horizontal stepper: one continuous progress line broken into
// (milestones.length - 1) segments, a breaker dot at every milestone, and a
// date/label row underneath. The fill is continuous within the live
// segment (e.g. exactly halfway between two dates lands the edge at that
// segment's midpoint), not snapped fully to the next milestone the moment
// its date arrives.
export function IpoTimeline({ milestones }: IpoTimelineProps) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), RECOMPUTE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  // The latest milestone whose instant has actually arrived — -1 means
  // none yet (e.g. an "Upcoming" IPO that hasn't opened). Close uses its
  // real 4:50pm IST cutoff (milestoneInstantMs), not just its calendar
  // date, so this stays on "Open" for the rest of the close date's
  // afternoon, matching isOpenForBidding elsewhere.
  let currentIdx = -1
  milestones.forEach((m, i) => {
    if (m.date && milestoneInstantMs(m.label, m.date) <= now) currentIdx = i
  })
  const segmentCount = milestones.length - 1

  // Continuous fill fraction per segment (0..1) — segments fully before the
  // live position are 1, fully after are 0, and the one live segment is
  // whatever fraction of its own span has elapsed. Undated milestones (TBA
  // allotment/listing) can't be interpolated into — that segment either
  // stays fully unfilled (its start hasn't happened) or, if its start
  // milestone HAS happened but the end date is unknown, holds at the start
  // (0) rather than guessing how far through an undated span "now" is.
  const segmentFill = Array.from({ length: Math.max(segmentCount, 0) }, (_, i) => {
    const startDate = milestones[i].date
    const endDate = milestones[i + 1].date
    if (!startDate) return 0 // segment hasn't started
    const startTs = milestoneInstantMs(milestones[i].label, startDate)
    if (now < startTs) return 0 // segment hasn't started
    if (!endDate) return 0 // started, but next milestone's date unknown — nothing to interpolate toward
    const endTs = milestoneInstantMs(milestones[i + 1].label, endDate)
    if (now >= endTs) return 1 // segment has fully elapsed
    if (endTs <= startTs) return 1 // guard against equal/out-of-order dates
    return Math.min(1, Math.max(0, (now - startTs) / (endTs - startTs)))
  })

  return (
    <div>
      {/* The line and its breaker dots are one element, not two things
          stacked — each dot sits exactly at its milestone's position on the
          line (i / segmentCount), lit the same fill color the moment that
          milestone is reached, animated in sync with the line's own fill
          transition. */}
      <div className="flex items-center gap-1">
        {segmentFill.map((fill, i) => (
          <div
            key={i}
            className="h-1 flex-1 rounded-full"
            style={{
              background: `linear-gradient(to right, var(--good) ${fill * 100}%, var(--border) ${fill * 100}%)`,
              transition: 'background 0.6s ease',
            }}
          />
        ))}
      </div>
      <div className="mt-2 grid gap-1 text-xs" style={{ gridTemplateColumns: `repeat(${milestones.length}, minmax(0, 1fr))` }}>
        {milestones.map((m, i) => {
          const isCurrent = i === currentIdx
          return (
            <div key={`${m.label}-${i}`}>
              <p
                className="font-mono-ipo tabular-nums"
                style={{ fontWeight: isCurrent ? 700 : 400, color: isCurrent ? 'var(--ink-primary)' : 'var(--ink-muted)' }}
              >
                {formatDate(m.date)}
              </p>
              <p style={{ color: 'var(--ink-muted)' }}>
                {m.label}
                {m.estimated && m.date ? '*' : ''}
              </p>
            </div>
          )
        })}
      </div>
    </div>
  )
}
