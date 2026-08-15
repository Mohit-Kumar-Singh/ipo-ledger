import { Link } from 'react-router-dom'
import { CheckCircleIcon } from '@primer/octicons-react'
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
  allottedCount,
  ipoId,
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
  // How many demat accounts are already marked ALLOTTED (or SOLD) for this
  // IPO — 0 hides the badge entirely rather than showing "0 allotted"
  // before anyone's marked anything yet.
  allottedCount: number
  ipoId: string
}) {
  const accountsLeft = Math.max(totalActive - applied, 0)
  const canExpand = accountsLeft > 0

  return (
    <div className="glass-card stagger-item p-3">
      {/* "N left" used to sit here as its own badge — moved down into
          IpoProgressGauge itself, directly under the applied/total ratio
          it's derived from, since it's a reading of the ring, not a
          separate header-level fact. */}
      <div className="mb-2 flex items-center gap-2">
        <h3 className="truncate text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          {companyName}
        </h3>
        {allottedCount > 0 && (
          <Link
            to={`/allotment?ipo=${ipoId}`}
            onClick={(e) => e.stopPropagation()}
            title={`${allottedCount} account(s) marked allotted — open the allotment board`}
            className="badge badge-good inline-flex shrink-0 items-center gap-1 text-xs no-underline"
          >
            <CheckCircleIcon size={12} />
            {allottedCount} allotted
          </Link>
        )}
      </div>

      {/* GMP + subscription rate on one line instead of two stacked ones —
          both are short, and stacking them was one more row of height this
          card didn't need. */}
      {(gmpNotes || subscriptionRate) && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {gmpNotes && (
            <p
              className="font-mono-ipo inline-block truncate rounded-full px-2.5 py-0.5 text-xs"
              style={{ background: 'var(--hover-surface)', color: 'var(--ink-secondary)' }}
            >
              {gmpNotes}
            </p>
          )}
          {subscriptionRate && (
            <p className="font-mono-ipo truncate text-xs font-medium" style={{ color: 'var(--accent)' }}>
              Retail subscription: {subscriptionRate}
            </p>
          )}
        </div>
      )}

      <IpoTimeline openDate={openDate} closeDate={closeDate} allotmentDate={allotmentDate} listingDate={listingDate} />

      {/* Pie chart, progress ring, and (once expanded) the "accounts yet to
          apply" list all sit in this one row — the list used to live in a
          separate block below, full-width; now it opens up right beside
          the ring instead, same row as the pie chart. */}
      <div
        className="mt-3 flex flex-wrap items-start justify-center gap-4 border-t pt-3"
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
            several cards can be open across the grid at once. Capped at
            ~6 rows' worth (not 400px) — the old cap let the whole card
            visibly grow/shrink by however many accounts were left (one
            account looked nothing like thirty); now the list's own height
            barely moves regardless of count, it just scrolls internally
            past 5-6 rows instead of pushing the card taller. */}
        <div
          className="overflow-hidden"
          style={{
            maxWidth: expanded ? 210 : 0,
            maxHeight: expanded ? 190 : 0,
            transition: 'max-width 0.35s cubic-bezier(0.16, 1, 0.3, 1), max-height 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <div className="w-[210px] border-l pl-3" style={{ borderColor: 'var(--border)' }} onClick={(e) => e.stopPropagation()}>
            <p className="mb-1 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              Accounts yet to apply ({remainingHolderNames.length})
            </p>
            <ul className="max-h-[164px] overflow-y-auto">
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
