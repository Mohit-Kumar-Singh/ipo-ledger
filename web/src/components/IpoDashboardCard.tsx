import { AttributionChart } from './AttributionChart'
import { IpoProgressGauge } from './IpoProgressGauge'
import { IpoTimeline } from './IpoTimeline'
import type { IpoAttribution } from '../lib/applicationAttribution'

// One self-contained card per IPO — company name/GMP/subscription/dates up
// top, the attribution donut and the progress ring side by side below.
// Clicking specifically the "N left" badge inside the gauge (not the card
// at large) reveals that IPO's own "accounts yet to apply" list — the
// whole card used to be one big click target, which meant clicking
// anywhere near the donut/legend/dates to, say, read a name also toggled
// the expand panel as an unwanted side effect.
export function IpoDashboardCard({
  companyName,
  openDate,
  closeDate,
  allotmentDate,
  listingDate,
  gmpNotes,
  subscriptionRate,
  applied,
  totalActive,
  remainingHolderNames,
  attribution,
  expanded,
  onToggleExpanded,
}: {
  companyName: string
  openDate: string
  closeDate: string | null
  allotmentDate: string | null
  listingDate: string | null
  gmpNotes: string | null
  subscriptionRate: string | null
  applied: number
  totalActive: number
  remainingHolderNames: string[]
  attribution: IpoAttribution | undefined
  expanded: boolean
  onToggleExpanded: () => void
}) {
  const accountsLeft = Math.max(totalActive - applied, 0)
  const canExpand = accountsLeft > 0

  return (
    <div className="glass-card stagger-item p-4">
      {/* "N left" used to sit here as its own badge — moved down into
          IpoProgressGauge itself, directly under the applied/total ratio
          it's derived from, since it's a reading of the ring, not a
          separate header-level fact. */}
      <h3 className="mb-3 truncate text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
        {companyName}
      </h3>

      {gmpNotes && (
        <p
          className="font-mono-ipo mb-1 inline-block truncate rounded-full px-2.5 py-0.5 text-xs"
          style={{ background: 'var(--hover-surface)', color: 'var(--ink-secondary)' }}
        >
          {gmpNotes}
        </p>
      )}
      {subscriptionRate && (
        <p className="font-mono-ipo mb-2 text-xs font-medium" style={{ color: 'var(--accent)' }}>
          Retail subscription: {subscriptionRate}
        </p>
      )}

      <IpoTimeline openDate={openDate} closeDate={closeDate} allotmentDate={allotmentDate} listingDate={listingDate} />

      {/* Pie chart, progress ring, and (once expanded) the "accounts yet to
          apply" list all sit in this one row — the list used to live in a
          separate block below, full-width; now it opens up right beside
          the ring instead, same row as the pie chart. */}
      <div
        className="mt-4 flex flex-wrap items-start justify-center gap-6 border-t pt-4"
        style={{ borderColor: 'var(--border)' }}
      >
        {attribution && <AttributionChart attribution={attribution} hideHeader />}
        <IpoProgressGauge
          applied={applied}
          total={totalActive}
          expanded={canExpand ? expanded : undefined}
          onToggleExpanded={canExpand ? onToggleExpanded : undefined}
        />

        {/* max-width + max-height, not conditional mounting — animates
            open/closed instead of snapping, same technique the old side
            panel used. Each card manages this independently (expanded is
            per-ipoId from the caller's Set, not one shared boolean), so
            several cards can be open across the grid at once. */}
        <div
          className="overflow-hidden"
          style={{
            maxWidth: expanded ? 210 : 0,
            maxHeight: expanded ? 400 : 0,
            transition: 'max-width 0.35s cubic-bezier(0.16, 1, 0.3, 1), max-height 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <div className="w-[210px] border-l pl-3" style={{ borderColor: 'var(--border)' }} onClick={(e) => e.stopPropagation()}>
            <p className="mb-1 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              Accounts yet to apply ({remainingHolderNames.length})
            </p>
            <ul className="max-h-64 overflow-y-auto">
              {remainingHolderNames.map((name) => (
                <li
                  key={name}
                  className="truncate border-b py-1.5 text-xs last:border-b-0"
                  style={{ borderColor: 'var(--border)', color: 'var(--ink-secondary)' }}
                >
                  {name}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
