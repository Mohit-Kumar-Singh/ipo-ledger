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

// Straight port of the reference's stageSet()/segs() (IPO Tracker.dc.html) —
// discrete on/off segments and exactly one bolded "current" stage, not the
// fractional/multi-bold version this used to have. currentIdx there was a
// hand-set field per mock row (0 for every "Open" example, -1 for every
// "Upcoming" one); here it's derived from real dates instead of a fixed
// per-status value, which is what actually varies once an IPO moves past
// Open into Close/Allotment/Listed.
export function IpoTimeline({ openDate, closeDate, allotmentDate, listingDate }: IpoTimelineProps) {
  const todayIso = new Date().toISOString().slice(0, 10)

  const stages: Stage[] = [
    { label: 'Open', date: openDate, estimated: false },
    { label: 'Close', date: closeDate, estimated: false },
    { label: 'Allotment', date: allotmentDate, estimated: true },
    { label: 'Listing', date: listingDate, estimated: true },
  ]

  // The latest stage whose date has actually arrived — matches the
  // reference's currentIdx (0 = "we're in the Open window" for its Open
  // examples, -1 = "hasn't opened yet" for its Upcoming ones).
  let currentIdx = -1
  stages.forEach((s, i) => {
    if (s.date && s.date <= todayIso) currentIdx = i
  })
  const segmentCount = stages.length - 1
  const filled = currentIdx >= 0 ? Math.min(currentIdx + 1, segmentCount) : 0

  return (
    <div>
      <div className="flex items-center gap-1">
        {Array.from({ length: segmentCount }, (_, i) => (
          <div
            key={i}
            className="h-[3px] flex-1 rounded-full"
            style={{ background: i < filled ? 'var(--good)' : 'var(--border)' }}
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
