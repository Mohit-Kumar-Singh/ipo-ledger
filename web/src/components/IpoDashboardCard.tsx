import { AttributionChart } from './AttributionChart'
import { IpoProgressGauge } from './IpoProgressGauge'
import { IpoTimeline } from './IpoTimeline'
import type { IpoAttribution } from '../lib/applicationAttribution'

// One self-contained card per IPO — company name/GMP/subscription/dates up
// top, the attribution donut and the progress ring side by side below,
// click-anywhere-on-the-card to reveal that IPO's own "accounts yet to
// apply" list. Previously these were two separately-laid-out pieces (a
// gauge tile in one section, a donut tile in a different section entirely)
// that only lined up by accident of matching widths/heights — genuinely
// two different DOM subtrees for the same IPO, with only the gauge side
// having any expand behavior at all. This is the single card the
// Dashboard's grid renders per IPO now.
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
    <div
      className={`glass-card stagger-item p-4 ${canExpand ? 'cursor-pointer' : ''}`}
      role={canExpand ? 'button' : undefined}
      tabIndex={canExpand ? 0 : undefined}
      aria-expanded={canExpand ? expanded : undefined}
      onClick={canExpand ? onToggleExpanded : undefined}
      onKeyDown={
        canExpand
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onToggleExpanded()
              }
            }
          : undefined
      }
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="truncate text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          {companyName}
        </h3>
        <span
          className="badge badge-neutral shrink-0 text-xs"
          title={canExpand ? 'Click card for accounts yet to apply' : 'Everyone active has applied'}
        >
          {accountsLeft} left
        </span>
      </div>

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

      <div className="mt-4 flex flex-wrap items-center justify-center gap-6 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
        {attribution && <AttributionChart attribution={attribution} hideHeader />}
        <IpoProgressGauge applied={applied} total={totalActive} />
      </div>

      {/* max-height, not conditional mounting — so this animates open/closed
          instead of snapping, same technique the old side panel used. Each
          card manages this independently (expanded is per-ipoId from the
          caller's Set, not one shared boolean), so several cards can be
          open across the grid at once, not just one at a time. */}
      <div
        className="overflow-hidden"
        style={{ maxHeight: expanded ? 400 : 0, transition: 'max-height 0.35s cubic-bezier(0.16, 1, 0.3, 1)' }}
      >
        <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border)' }} onClick={(e) => e.stopPropagation()}>
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
  )
}
