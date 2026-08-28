// One funder's settlement statement — what they are owed, what has actually
// been sent, and the balance between the two, per IPO and in total.
//
// CONFIRMED money only. Everything on this page comes from applications
// marked SOLD with a real sell_price, and from settlement_payments rows that
// represent transfers that actually happened. No projection, estimate, or
// GMP-derived figure appears anywhere here — those live on the admin
// Payouts page under "Expected — not yet sold", clearly separated from
// money that's genuinely owed.
//
// Reached two ways: an admin clicks a funder's name on the main Payouts
// page (/payouts/funder/:funderName); a funder-only viewer lands here
// directly by visiting /payouts itself (PayoutsPage renders this same
// component with no param, and v_allotment_board is already RLS-scoped to
// just their own data, so no filtering is needed for that case).
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { usePayoutsData } from '../../lib/usePayoutsData'
import { sameIdentity } from '../../lib/applicationAttribution'
import { rupees } from '../../lib/expectedProfit'
import { groupCardsByIpo, SETTLED_EPSILON } from '../../lib/settlement'
import { IpoSettlementCard } from './PayoutsPage'
import { InlineSpinner } from '../../components/PageSpinner'
import { ChevronLeftIcon } from '@primer/octicons-react'

export function FunderPayoutsPage() {
  const { funderName: funderNameParam } = useParams<{ funderName?: string }>()
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const decodedName = funderNameParam ? decodeURIComponent(funderNameParam) : null
  const { settlementCards, loading, loadError, invalidatePayoutsData } = usePayoutsData()

  // Admin scopes by the :funderName in the route. A funder-only viewer has
  // no param, and RLS alone is NOT a sufficient filter here: p_apps_member_write
  // on `applications` is `for ALL` (which includes SELECT), so a viewer who
  // also owns a demat account can see applications on that account funded by
  // somebody else. `hasFunder && !isFunderSelf` is true for exactly those,
  // which would total another person's outstanding balance into this
  // viewer's own "Total to be sent". Matching on funderLinkedUserId (the
  // portal user who owns the funding bank account, migration 0090) keeps
  // this to rows they genuinely funded.
  const myCards = decodedName
    ? settlementCards.filter((c) => c.hasFunder && !c.isFunderSelf && sameIdentity(c.funderName ?? '', decodedName))
    : settlementCards.filter((c) => c.hasFunder && !c.isFunderSelf && c.funderLinkedUserId === profile?.id)
  const displayName = decodedName ?? myCards[0]?.funderName ?? 'Your'

  // A settlement statement, not a dashboard: three figures that reconcile
  // by simple subtraction, all of them CONFIRMED money from applications
  // actually marked SOLD.
  //
  //   totalDue − totalSent = remaining
  //
  // Nothing estimated appears here. This page used to also show an
  // "Expected" figure (a GMP/live-price projection of what allotted-but-
  // unsold applications MIGHT eventually be worth) sitting in the same row
  // as real settled amounts, which read as a fourth transaction figure and
  // could not be reconciled against the other three. That was the actual
  // reported confusion — it wasn't a labelling problem, an estimate simply
  // does not belong in a money-owed statement. Admin still has that
  // projection on the main Payouts page ("Expected — not yet sold").
  //
  // remaining is summed RAW and clamped nowhere: an overpaid application
  // legitimately reduces what this same person is owed on another, and a
  // net-negative balance is real money coming back. Clamping per card is
  // what made this page disagree with the main page for the same funder.
  const totalDue = myCards.reduce((s, c) => s + c.amountToFunder, 0)
  const totalSent = myCards.reduce((s, c) => s + (c.amountToFunder - c.remainingToFunder), 0)
  const remaining = totalDue - totalSent
  const isOverpaid = remaining < -SETTLED_EPSILON
  const isSettled = Math.abs(remaining) <= SETTLED_EPSILON
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

      {/* Settlement statement. Three figures that subtract into each other,
          with the arithmetic spelled out underneath — the point is that the
          balance is never a number you have to take on trust. */}
      <div className="card p-4">
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>Total to be sent</p>
            <p className="font-mono-ipo font-semibold" style={{ color: 'var(--ink-primary)' }}>{rupees(totalDue)}</p>
          </div>
          <div>
            <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>Total sent</p>
            <p className="font-mono-ipo font-semibold" style={{ color: 'var(--good)' }}>{rupees(totalSent)}</p>
          </div>
          <div>
            <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
              {isOverpaid ? 'Overpaid' : 'Remaining'}
            </p>
            <p
              className="font-mono-ipo font-semibold"
              style={{ color: isSettled ? 'var(--good)' : isOverpaid ? 'var(--warning-text)' : 'var(--critical-text)' }}
            >
              {isOverpaid ? `−${rupees(-remaining)}` : rupees(remaining)}
            </p>
          </div>
        </div>
        <p className="mt-3 border-t pt-2 text-[11px]" style={{ borderColor: 'var(--border)', color: 'var(--ink-muted)' }}>
          {rupees(totalDue)} due − {rupees(totalSent)} sent ={' '}
          {isSettled
            ? 'settled in full'
            : isOverpaid
              ? `${rupees(-remaining)} sent in excess, owed back to you`
              : `${rupees(remaining)} still to send`}
        </p>
      </div>

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
        <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
          No settled transactions yet.
        </p>
      )}
    </div>
  )
}
