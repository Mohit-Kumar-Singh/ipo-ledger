interface IpoTimelineProps {
  openDate: string | null
  closeDate: string | null
  allotmentDate: string | null
  listingDate: string | null
}

interface Step {
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

function segmentFill(startIso: string | null, endIso: string | null, todayIso: string): number {
  if (!startIso || !endIso) return 0
  if (endIso <= startIso) return todayIso >= endIso ? 1 : 0
  if (todayIso <= startIso) return 0
  if (todayIso >= endIso) return 1
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  const today = Date.parse(todayIso)
  return (today - start) / (end - start)
}

const CHEVRON_CLIP = 'polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%, 10px 50%)'

export function IpoTimeline({ openDate, closeDate, allotmentDate, listingDate }: IpoTimelineProps) {
  const todayIso = new Date().toISOString().slice(0, 10)

  const steps: Step[] = [
    { label: 'Open', date: openDate, estimated: false },
    { label: 'Close', date: closeDate, estimated: false },
    { label: 'Allotment', date: allotmentDate, estimated: true },
    { label: 'Listing', date: listingDate, estimated: true },
  ]

  const segments = [
    segmentFill(openDate, closeDate, todayIso),
    segmentFill(closeDate, allotmentDate, todayIso),
    segmentFill(allotmentDate, listingDate, todayIso),
  ]

  return (
    <div>
      <div className="flex h-2.5 gap-0.5">
        {segments.map((fill, i) => (
          <div
            key={i}
            className="relative flex-1 overflow-hidden"
            style={{ background: 'var(--border)', clipPath: CHEVRON_CLIP }}
          >
            <div
              className="absolute inset-y-0 left-0 transition-[width] duration-700 ease-out"
              style={{ width: `${fill * 100}%`, background: 'var(--accent)' }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1 text-xs">
        {steps.map((s) => {
          const done = s.date != null && s.date <= todayIso
          return (
            <div key={s.label}>
              <p
                className="font-mono-ipo tabular-nums"
                style={{ fontWeight: done ? 600 : 400, color: done ? 'var(--ink-primary)' : 'var(--ink-muted)' }}
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
