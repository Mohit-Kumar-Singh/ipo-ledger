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
import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { showToast } from '../../lib/toast'
import { maybeAutoArchiveIpo } from '../../lib/autoArchive'
import { usePayoutsData } from '../../lib/usePayoutsData'
import { sameIdentity } from '../../lib/applicationAttribution'
import { rupees } from '../../lib/expectedProfit'
import { groupCardsByIpo, settledPaidFlags, SETTLED_EPSILON, type SettlementCard } from '../../lib/settlement'
import { IpoSettlementCard } from './PayoutsPage'
import { InlineSpinner } from '../../components/PageSpinner'
import { ChevronLeftIcon } from '@primer/octicons-react'

export function FunderPayoutsPage() {
  const { funderName: funderNameParam } = useParams<{ funderName?: string }>()
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const decodedName = funderNameParam ? decodeURIComponent(funderNameParam) : null
  const { settlementCards, boardQuery, loading, loadError, invalidatePayoutsData } = usePayoutsData()

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
  // Allotted, not yet sold — the positions this funder's money is currently
  // sitting in. Scoped exactly like myCards above (name for admin,
  // funding-account owner for a funder viewing themselves).
  //
  // Shown as FACTS only: which IPO, whose account, how much was actually
  // put in (bid_amount, a real recorded number). Deliberately no projected
  // return — that estimate is what made this page unreadable before. But
  // dropping the section entirely (v1.204.0) went too far: a funder could
  // no longer see that their money was committed to an IPO at all, only
  // settled history. Both of those are wrong; the fix is real numbers, not
  // no numbers.
  const allottedRows = (boardQuery.data ?? []).filter((r) => {
    if (r.status !== 'ALLOTTED') return false
    if (!r.bank_account_holder_name) return false
    if (r.bank_account_holder_name === r.holder_name) return false
    return decodedName
      ? sameIdentity(r.bank_account_holder_name, decodedName)
      : r.bank_account_linked_user_id === profile?.id
  })
  const allottedInvested = allottedRows.reduce((s, r) => s + (r.bid_amount ?? 0), 0)

  const displayName = decodedName ?? myCards[0]?.funderName ?? allottedRows[0]?.bank_account_holder_name ?? 'Your'

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

        {/* Admin-only bulk settle — for when the whole outstanding balance was
            cleared in ONE physical transfer, rather than one payment per sold
            application. Logs an admin_to_funder settlement_payment against each
            still-outstanding IPO (most-outstanding first) until the entered
            amount is used up, all sharing the one note. settlement_payments is
            admin-only at the RLS level anyway, so a funder viewing their own
            page never sees this. */}
        {isAdmin && !isSettled && !isOverpaid && remaining > SETTLED_EPSILON && (
          <BulkSettleControl cards={myCards} remaining={remaining} onDone={invalidatePayoutsData} />
        )}
      </div>

      {/* Allotted, not yet sold — where this funder's money currently is.
          Facts only: IPO, whose account, and what was actually invested.
          No projected return (see allottedRows' own comment). */}
      {allottedRows.length > 0 && (
        <div className="card p-4 text-sm">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-medium tracking-wide uppercase" style={{ color: 'var(--ink-muted)' }}>
              Allotted — awaiting sale
            </p>
            <span className="shrink-0 font-mono-ipo text-xs font-semibold" style={{ color: 'var(--ink-primary)' }}>
              {rupees(allottedInvested)} invested
            </span>
          </div>
          <div className="space-y-1">
            {allottedRows.map((r) => (
              <div key={r.application_id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate" style={{ color: 'var(--ink-primary)' }}>
                  {r.company_name.split(' ')[0]}
                  <span style={{ color: 'var(--ink-muted)' }}> · {r.holder_name}</span>
                </span>
                <span className="shrink-0 font-mono-ipo text-xs" style={{ color: 'var(--ink-muted)' }}>
                  {rupees(r.bid_amount ?? 0)}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 border-t pt-2 text-[11px]" style={{ borderColor: 'var(--border)', color: 'var(--ink-muted)' }}>
            Nothing is owed on these yet — they settle once marked sold.
          </p>
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
        allottedRows.length === 0 && (
          <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
            Nothing allotted or sold yet.
          </p>
        )
      )}
    </div>
  )
}

// Settles this funder's entire outstanding balance in one go — the case
// where the admin sent the whole amount as a single physical transfer
// instead of app-by-app. Distributes the entered amount greedily across the
// funder's still-outstanding IPO cards (largest remaining first), logging
// one admin_to_funder settlement_payment per card via the same audited
// log_settlement_payment RPC the per-application form uses (atomic payment +
// paid-flag write, migration 0087). An amount smaller than the full balance
// leaves the rest outstanding; an amount larger than the balance never
// overpays — the excess is simply not logged.
function BulkSettleControl({
  cards,
  remaining,
  onDone,
}: {
  cards: SettlementCard[]
  remaining: number
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState(String(Math.round(remaining)))
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    const amt = Number(amount)
    if (!amt || amt <= 0) {
      showToast('Enter an amount greater than 0.', 'warning')
      return
    }
    const targets = cards
      .filter((c) => c.remainingToFunder > SETTLED_EPSILON)
      .sort((a, b) => b.remainingToFunder - a.remainingToFunder)
    if (targets.length === 0) {
      showToast('Nothing outstanding to settle.', 'info')
      setOpen(false)
      return
    }

    setSaving(true)
    let left = amt
    let applied = 0
    const touchedIpoIds = new Set<string>()
    try {
      for (const c of targets) {
        if (left <= SETTLED_EPSILON) break
        const alloc = Math.min(left, c.remainingToFunder)
        const flags = settledPaidFlags(c, c.remainingFromHolder, c.remainingToFunder - alloc)
        const { error } = await supabase.rpc('log_settlement_payment', {
          p_application_id: c.applicationId,
          p_kind: 'admin_to_funder',
          p_amount: alloc,
          p_note: note.trim() || null,
          // Fresh key per card — there's no retry loop here (a failure aborts
          // the batch and surfaces a toast), so each call is its own attempt.
          p_idempotency_key: crypto.randomUUID(),
          p_set_demat_cut_paid: !!flags.demat_cut_paid,
          p_set_funder_share_paid: !!flags.funder_share_paid,
        })
        // 23505 = this exact key already landed; treat as done, same as the
        // per-application form.
        if (error && error.code !== '23505') throw error
        left -= alloc
        applied += alloc
        touchedIpoIds.add(c.ipoId)
      }
      // Settling the last side of the last unsettled row on an IPO can be
      // what makes it archivable — same check the per-application form runs.
      for (const ipoId of touchedIpoIds) await maybeAutoArchiveIpo(ipoId)
      showToast(
        `Logged ${rupees(applied)} across ${touchedIpoIds.size} IPO${touchedIpoIds.size === 1 ? '' : 's'}.`,
        'good',
      )
      setOpen(false)
      setNote('')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to log settlement.', 'critical')
    } finally {
      setSaving(false)
      // Refresh regardless — on a partial failure some payments did land and
      // the statement above needs to reflect them.
      onDone()
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="link-accent mt-2 text-xs font-medium">
        + Settle full balance
      </button>
    )
  }

  return (
    <div className="mt-3 space-y-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
      <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
        Records one physical transfer against every outstanding IPO for this funder.
      </p>
      <div className="flex gap-2">
        <input
          type="number"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount"
          className="input text-xs"
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (e.g. UPI ref, date) — optional"
          className="input text-xs"
        />
      </div>
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving} className="btn-primary text-xs disabled:opacity-50">
          {saving ? 'Logging…' : 'Log settlement'}
        </button>
        <button onClick={() => setOpen(false)} disabled={saving} className="btn-secondary text-xs disabled:opacity-50">
          Cancel
        </button>
      </div>
    </div>
  )
}
