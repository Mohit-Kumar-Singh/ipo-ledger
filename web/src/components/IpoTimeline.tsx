import { useEffect, useState } from 'react'

interface IpoTimelineProps {
  openDate: string | null
  closeDate: string | null
  allotmentDate: string | null
  listingDate: string | null
}

interface Stage {
  label: string
  date: string | null
  estimated: boolean
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

function toMidnightUtc(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

// 12h, not a per-second/per-minute tick — the underlying stage dates only
// change daily at most, so anything finer than "twice a day" is spending
// re-renders on a value that can't have meaningfully moved. Recomputing on
// an interval (not just once on mount) is what makes the segment actually
// creep forward across a page left open, rather than freezing at whatever
// fraction it happened to load at.
const RECOMPUTE_INTERVAL_MS = 12 * 60 * 60 * 1000

// Straight port of the reference's stageSet()/segs() (IPO Tracker.dc.html)
// for the stage set/labels/bolding — but the fill itself is continuous, not
// discrete: the leading edge sits at how far elapsed time is through the
// CURRENT segment (e.g. exactly halfway between Open and Close lands the
// edge at the segment's midpoint), not snapped fully to the next stage the
// moment its date arrives.
export function IpoTimeline({ openDate, closeDate, allotmentDate, listingDate }: IpoTimelineProps) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), RECOMPUTE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  const todayIso = new Date(now).toISOString().slice(0, 10)

  const stages: Stage[] = [
    { label: 'Open', date: openDate, estimated: false },
    { label: 'Close', date: closeDate, estimated: false },
    { label: 'Allotment', date: allotmentDate, estimated: true },
    { label: 'Listing', date: listingDate, estimated: true },
  ]

  // The latest stage whose date has actually arrived — matches the
  // reference's currentIdx (0 = "we're in the Open window" for its Open
  // examples, -1 = "hasn't opened yet" for its Upcoming ones). Still
  // date-based (which stage is "current" for bolding), independent of the
  // continuous fill below.
  let currentIdx = -1
  stages.forEach((s, i) => {
    if (s.date && s.date <= todayIso) currentIdx = i
  })
  const segmentCount = stages.length - 1

  // Continuous fill fraction per segment (0..1) — segments fully before the
  // live position are 1, fully after are 0, and the one live segment is
  // whatever fraction of its own span has elapsed. Undated stages (TBA
  // allotment/listing) can't be interpolated into — that segment either
  // stays fully unfilled (its start hasn't happened) or, if its start
  // stage HAS happened but the end date is unknown, holds at the start
  // (0) rather than guessing how far through an undated span "now" is.
  const segmentFill = Array.from({ length: segmentCount }, (_, i) => {
    const startDate = stages[i].date
    const endDate = stages[i + 1].date
    if (!startDate || startDate > todayIso) return 0 // segment hasn't started
    if (!endDate) return 0 // started, but next stage date unknown — nothing to interpolate toward
    if (endDate <= todayIso) return 1 // segment has fully elapsed
    const startTs = toMidnightUtc(startDate)
    const endTs = toMidnightUtc(endDate)
    if (endTs <= startTs) return 1 // guard against equal/out-of-order dates
    return Math.min(1, Math.max(0, (now - startTs) / (endTs - startTs)))
  })

  return (
    <div>
      <div className="flex items-center gap-1">
        {segmentFill.map((fill, i) => (
          <div
            key={i}
            className="h-[3px] flex-1 rounded-full"
            style={{
              background: `linear-gradient(to right, var(--good) ${fill * 100}%, var(--border) ${fill * 100}%)`,
              transition: 'background 0.6s ease',
            }}
          />
        ))}
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1 text-xs">
        {stages.map((s, i) => {
          const isCurrent = i === currentIdx
          return (
            <div key={s.label}>
              <p
                className="font-mono-ipo tabular-nums"
                style={{ fontWeight: isCurrent ? 700 : 400, color: isCurrent ? 'var(--ink-primary)' : 'var(--ink-muted)' }}
              >
                {formatDate(s.date)}
              </p>
              <p style={{ color: 'var(--ink-muted)' }}>
                {s.label}
                {s.estimated && s.date ? '*' : ''}
              </p>
            </div>
          )
        })}
      </div>
    </div>
  )
}
