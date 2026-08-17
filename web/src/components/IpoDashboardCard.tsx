import { Link } from 'react-router-dom'
import { CheckCircleIcon } from '@primer/octicons-react'
import { AttributionChart, AttributionLegend } from './AttributionChart'
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
  shareholderIssueSize,
  parentCompanyName,
  parentPrice,
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
  // Shareholder-quota badge trigger + parent company display (e.g. CMPDI's
  // quota for existing Coal India shareholders) — see IposPage's IpoCard for
  // the admin-side equivalent. parentPrice is looked up by the page (one
  // batched fetch-stock-price call per load), not fetched per card.
  shareholderIssueSize?: string | null
  parentCompanyName?: string | null
  parentPrice?: { price: number | null; stale: boolean }
}) {
  const accountsLeft = Math.max(totalActive - applied, 0)
  const canExpand = accountsLeft > 0

  return (
    <div className="glass-card stagger-item space-y-2.5 p-4">
      {/* "N left" used to sit here as its own badge — moved down into
          IpoProgressGauge itself, directly under the applied/total ratio
          it's derived from, since it's a reading of the ring, not a
          separate header-level fact. */}
      <div className="flex items-center gap-2">
        <h3 className="truncate text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          {companyName}
        </h3>
        {shareholderIssueSize && <span className="badge badge-info shrink-0 text-xs">Shareholder quota</span>}
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
        <div className="flex flex-wrap items-center gap-2">
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

      {parentCompanyName && (
        <p className="font-mono-ipo truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
          Parent: {parentCompanyName}
          {parentPrice?.price != null && ` · ₹${parentPrice.price}`}
          {parentPrice?.stale && ' (stale)'}
        </p>
      )}

      <IpoTimeline
        milestones={[
          { date: openDate, label: 'Open' },
          { date: closeDate, label: 'Close' },
          { date: allotmentDate, label: 'Allotment', estimated: true },
          { date: listingDate, label: 'Listing', estimated: true },
        ]}
      />

      {/* Phone: a strict 2x2 quadrant grid — pie chart / funder legend on
          row 1, progress tracker / accounts-left list on row 2 — instead of
          the desktop row, which has no room on a phone width for 3-4
          pieces side by side. The accounts-left list (quadrant 4) is always
          shown here, not gated behind a tap-to-expand — so the gauge's own
          expand toggle is disabled on phone (expanded/onToggleExpanded left
          undefined) since there's nothing left for it to reveal. Desktop/
          tablet (sm:+, hidden on phone): unchanged single row with the
          accounts list opening as a narrow sidebar next to the ring. */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 border-t pt-4 sm:hidden" style={{ borderColor: 'var(--border)' }}>
        <div className="flex min-w-0 items-center justify-center">
          {attribution && <AttributionChart attribution={attribution} hideHeader hideLegend compact />}
        </div>
        <div className="flex min-w-0 items-center">
          {attribution && <AttributionLegend attribution={attribution} firstNameOnly />}
        </div>
        <div className="flex min-w-0 items-center">
          <IpoProgressGauge applied={applied} total={totalActive} />
        </div>
        <div className="min-w-0">
          {canExpand ? (
            <>
              <p className="mb-1 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                Accounts yet to apply ({remainingHolderNames.length})
              </p>
              <ul className="max-h-32 overflow-y-auto">
                {remainingHolderNames.map((name) => (
                  <li
                    key={name}
                    className="truncate border-b py-1 text-xs last:border-b-0"
                    style={{ borderColor: 'var(--border)', color: 'var(--ink-secondary)' }}
                  >
                    {name}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              All accounts have applied
            </p>
          )}
        </div>
      </div>

      <div className="hidden items-center justify-center gap-5 border-t pt-4 sm:flex sm:flex-wrap" style={{ borderColor: 'var(--border)' }}>
        {attribution && <AttributionChart attribution={attribution} hideHeader />}
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
            the card's total height never changes on click. */}
        {canExpand && (
          <div
            className="overflow-hidden"
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
