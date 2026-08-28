// One funder's own detail page — every allotted IPO (sold and settled, or
// still held), money transactions, what's left to pay/receive, and one
// overall compact summary. Reached two ways: an admin clicks a funder's
// name on the main Payouts page (/payouts/funder/:funderName); a funder-only
// viewer lands here directly by visiting /payouts itself (PayoutsPage
// renders this same component with no param, and v_allotment_board/the
// ALLOTTED-with-embeds query are already RLS-scoped to just their own data,
// so no filtering is needed for that case).
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { usePayoutsData } from '../../lib/usePayoutsData'
import { sameIdentity } from '../../lib/applicationAttribution'
import { expectedProfitBreakdown, rupees } from '../../lib/expectedProfit'
import { groupCardsByIpo, SETTLED_EPSILON } from '../../lib/settlement'
import { IpoSettlementCard } from './PayoutsPage'
import { InlineSpinner } from '../../components/PageSpinner'
import { ChevronLeftIcon } from '@primer/octicons-react'

export function FunderPayoutsPage() {
  const { funderName: funderNameParam } = useParams<{ funderName?: string }>()
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const decodedName = funderNameParam ? decodeURIComponent(funderNameParam) : null
  const { settlementCards, expectedCards, livePriceBySymbol, loading, loadError, invalidatePayoutsData } = usePayoutsData()

  // Admin needs the param to know WHICH funder to scope down to; a
  // funder-only viewer's own data is already RLS-scoped, nothing to filter.
  const myCards = decodedName
    ? settlementCards.filter((c) => c.hasFunder && !c.isFunderSelf && sameIdentity(c.funderName ?? '', decodedName))
    : settlementCards.filter((c) => c.hasFunder && !c.isFunderSelf)
  const myExpected = decodedName ? expectedCards.filter((c) => sameIdentity(c.funderName, decodedName)) : expectedCards

  const displayName = decodedName ?? myCards[0]?.funderName ?? myExpected[0]?.funderName ?? 'Your'

  const totalToSend = myCards.reduce((s, c) => s + Math.max(0, c.remainingToFunder), 0)
  const totalSent = myCards.reduce((s, c) => s + (c.amountToFunder - c.remainingToFunder), 0)
  const totalExpected = myExpected.reduce(
    (s, c) => s + expectedProfitBreakdown(c, c.symbol ? livePriceBySymbol[c.symbol] : null).amountToReturn,
    0,
  )
  const soldGroups = groupCardsByIpo(myCards)

  if (loading) return <InlineSpinner />

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        {isAdmin && (
          <Link to="/payouts" aria-label="Back to Payouts" className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--hover-surface)]" style={{ color: 'var(--ink-muted)' }}>
            <ChevronLeftIcon size={16} />
          </Link>
        )}
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          {displayName}
        </h1>
      </div>

      {loadError && (
        <div className="card p-4 text-sm" style={{ borderColor: 'var(--critical)', color: 'var(--ink-primary)' }}>
          Couldn't load payouts: {loadError}
        </div>
      )}

      {/* Overall — short, compact, everything at a glance. */}
      <div className="card grid grid-cols-3 gap-3 p-4 text-sm">
        <div>
          <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>Send</p>
          <p className="font-mono-ipo font-semibold" style={{ color: totalToSend > SETTLED_EPSILON ? 'var(--critical-text)' : 'var(--good)' }}>
            {rupees(totalToSend)}
          </p>
        </div>
        <div>
          <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>Sent</p>
          <p className="font-mono-ipo font-semibold" style={{ color: 'var(--good)' }}>{rupees(totalSent)}</p>
        </div>
        <div>
          <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>Expected</p>
          <p className="font-mono-ipo font-semibold" style={{ color: 'var(--accent)' }}>{rupees(totalExpected)}</p>
        </div>
      </div>

      {/* Allotted, not yet sold — compact, IPO first name only. */}
      {myExpected.length > 0 && (
        <div className="card space-y-1.5 p-4 text-sm">
          <p className="text-xs font-medium tracking-wide uppercase" style={{ color: 'var(--ink-muted)' }}>
            Allotted — not yet sold
          </p>
          {myExpected.map((c) => {
            const b = expectedProfitBreakdown(c, c.symbol ? livePriceBySymbol[c.symbol] : null)
            return (
              <div key={c.key} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate" style={{ color: 'var(--ink-primary)' }}>
                  {c.ipoName.split(' ')[0]}
                </span>
                <span className="shrink-0 font-mono-ipo" style={{ color: 'var(--accent)' }}>
                  {rupees(b.amountToReturn)}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Sold — real settlement, with the log-a-payment control an admin
          uses; read-only for the funder themselves (settlement_payments
          writes are admin-only at the RLS level anyway). */}
      {soldGroups.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {soldGroups.map((g) => (
            <IpoSettlementCard key={g.ipoName} group={g} onLogged={invalidatePayoutsData} readOnly={!isAdmin} />
          ))}
        </div>
      ) : (
        myExpected.length === 0 && (
          <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
            Nothing allotted or sold yet.
          </p>
        )
      )}
    </div>
  )
}
