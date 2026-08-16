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

      <IpoTimeline
        milestones={[
          { date: openDate, label: 'Open' },
          { date: closeDate, label: 'Close' },
          { date: allotmentDate, label: 'Allotment', estimated: true },
          { date: listingDate, label: 'Listing', estimated: true },
        ]}
      />

      {/* Phone: stacked, full width, top to bottom — pie chart, then (once
          expanded) the accounts list as its own full-width scrollable
          block, then the progress ring. Desktop/tablet (sm:+): unchanged
          side-by-side row with the accounts list opening as a narrow
          sidebar next to the ring. Two separate accounts-list renders
          below (mobile-only / desktop-only via sm:hidden / hidden sm:block)
          rather than one that tries to serve both layouts — their sizing
          models are genuinely different (mobile: bounded height that
          scrolls, appended below; desktop: fixed constant height so
          expanding never changes the row's own height). */}
      <div
        className="mt-3 flex flex-col items-center gap-4 border-t pt-3 sm:flex-row sm:flex-wrap sm:justify-center"
        style={{ borderColor: 'var(--border)' }}
      >
        {attribution && <AttributionChart attribution={attribution} hideHeader />}

        {canExpand && expanded && (
          <div
            className="w-full border-t pt-3 sm:hidden"
            style={{ borderColor: 'var(--border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-1 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              Accounts yet to apply ({remainingHolderNames.length})
            </p>
            <ul className="max-h-48 overflow-y-auto">
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
        )}

        <IpoProgressGauge
          applied={applied}
          total={totalActive}
          expanded={canExpand ? expanded : undefined}
          onToggleExpanded={canExpand ? onToggleExpanded : undefined}
        />

        {/* max-width only, not conditional mounting — animates open/closed
            instead of snapping, same technique the old side panel used.
            Each card manages this independently (expanded is per-ipoId from
            the caller's Set, not one shared boolean), so several cards can
            be open across the grid at once.
            Height is a CONSTANT 168px always, collapsed or not — not
            toggled to 0. A toggled height was exactly what made expanding
            this panel grow the whole card (168px was taller than the
            chart/gauge next to it); reserving that height permanently means
            the card's total height never changes on click, and the pie
            chart/gauge (now items-center, not items-start) stay vertically
            centered against it whether the panel is showing or not. */}
        {canExpand && (
          <div
            className="hidden overflow-hidden sm:block"
            style={{
              maxWidth: expanded ? 210 : 0,
              height: 168,
              opacity: expanded ? 1 : 0,
              transition: 'max-width 0.35s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease',
            }}
          >
            {/* h-full + flex-col so the heading stays fixed and the list
                itself is the thing that scrolls (min-h-0 + flex-1 + its own
                overflow-y-auto) — the OUTER wrapper's height stays the same
                constant 168px either way (that's what keeps the card's own
                size from changing), but now every name is actually reachable
                by scrolling instead of the list capping at 5 + "N more". */}
            <div
              className="flex h-full w-[210px] flex-col border-l pl-3"
              style={{ borderColor: 'var(--border)' }}
              onClick={(e) => e.stopPropagation()}
            >
            <p className="mb-1 shrink-0 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              Accounts yet to apply ({remainingHolderNames.length})
            </p>
            <ul className="min-h-0 flex-1 overflow-y-auto">
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
        )}
      </div>
    </div>
  )
}
