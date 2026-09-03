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
import {
  groupCardsByIpo,
  settledPaidFlags,
  resolvedPaidFlags,
  remainingFromPayments,
  PAYMENT_KIND_LABELS,
  SETTLED_EPSILON,
  type SettlementCard,
} from '../../lib/settlement'
import { IpoSettlementCard } from './PayoutsPage'
import { InlineSpinner } from '../../components/PageSpinner'
import { ChevronLeftIcon } from '@primer/octicons-react'
import type { SettlementPayment, SettlementPaymentKind } from '../../types/database'

export function FunderPayoutsPage() {
  const { funderName: funderNameParam } = useParams<{ funderName?: string }>()
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const decodedName = funderNameParam ? decodeURIComponent(funderNameParam) : null
  const { settlementCards, boardQuery, loading, loadError, invalidatePayoutsData, profileNamesById } = usePayoutsData()

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

        {/* Admin-only bulk settle — for when a transfer to this funder was
            made in ONE payment rather than one-per-sold-application. Shown for
            every funder that has a settlement statement at all (>=1 sold,
            funded application), not just those still showing an outstanding
            balance: an admin may still need to record a physical transfer
            against a funder the ledger already thinks is square. The entered
            amount fills each application's outstanding room first, then any
            leftover lands on the largest card (which just shows up as an
            overpayment on the statement above). settlement_payments is
            admin-only at the RLS level, so a funder viewing their own page
            never sees this. */}
        {isAdmin && myCards.length > 0 && (
          <BulkSettleControl cards={myCards} remaining={remaining} onDone={invalidatePayoutsData} />
        )}
      </div>

      {/* Every settlement_payment logged against this funder's sold
          applications — the detail behind the three figures above. Each row
          is editable/removable by an admin (delete + re-set of the paid
          flags + archive re-sync run atomically server-side, migration
          0092). Empty (and so hidden) for a funder viewing their own page —
          settlement_payments is admin-only under RLS, so they get no rows. */}
      <FunderPaymentsLog cards={myCards} profileNamesById={profileNamesById} onChanged={invalidatePayoutsData} />

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
// instead of app-by-app. Distributes the entered amount across the funder's
// sold applications — each application's still-outstanding room first
// (largest first), then any leftover onto the largest card — logging one
// admin_to_funder settlement_payment per card that gets an allocation, via
// the same audited log_settlement_payment RPC the per-application form uses
// (atomic payment + paid-flag write, migration 0087).
//
// Available for every funder with a settlement statement, even one already
// square: an amount over the outstanding balance is still recorded in full
// and simply shows as an overpayment on the statement, rather than being
// silently dropped — the admin entered a real transfer that happened.
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
  // Default to the outstanding balance, or blank when nothing is owed (or
  // the funder's been overpaid) — the admin types the real figure in that
  // case rather than starting from a 0 or a negative.
  const [amount, setAmount] = useState(remaining > SETTLED_EPSILON ? String(Math.round(remaining)) : '')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    const amt = Number(amount)
    if (!amt || amt <= 0) {
      showToast('Enter an amount greater than 0.', 'warning')
      return
    }
    const ordered = [...cards].sort((a, b) => b.remainingToFunder - a.remainingToFunder)
    if (ordered.length === 0) {
      showToast('No sold applications for this funder yet.', 'info')
      setOpen(false)
      return
    }

    // Pass 1: fill each application's outstanding room, largest first.
    // Pass 2: whatever's still unallocated goes onto the largest card (which
    // then reads as an overpayment on that application). Keyed by index so a
    // card can pick up an allocation in both passes.
    const allocByIdx = new Map<number, number>()
    let left = amt
    ordered.forEach((c, i) => {
      const room = c.remainingToFunder > SETTLED_EPSILON ? c.remainingToFunder : 0
      const take = Math.min(left, room)
      if (take > 0) {
        allocByIdx.set(i, take)
        left -= take
      }
    })
    if (left > SETTLED_EPSILON) allocByIdx.set(0, (allocByIdx.get(0) ?? 0) + left)

    setSaving(true)
    let applied = 0
    const touchedIpoIds = new Set<string>()
    try {
      for (const [i, alloc] of allocByIdx) {
        const c = ordered[i]
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
        Records one physical transfer to this funder, spread across their sold applications.
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

// Flat, newest-first list of every settlement_payment on this funder's sold
// applications — the audit trail the three summary figures are built from,
// with per-row edit/delete for fixing a mistyped amount, wrong direction, or
// a duplicate. A funder viewing their own page gets no rows (RLS), so this
// renders nothing for them.
function FunderPaymentsLog({
  cards,
  profileNamesById,
  onChanged,
}: {
  cards: SettlementCard[]
  profileNamesById: Record<string, string>
  onChanged: () => void
}) {
  const entries = cards
    .flatMap((c) => c.payments.map((p) => ({ p, c })))
    // created_at is an ISO string — lexical sort is chronological.
    .sort((a, b) => (a.p.created_at < b.p.created_at ? 1 : -1))

  if (entries.length === 0) return null

  return (
    <div className="card p-4 text-sm">
      <p className="mb-2 text-xs font-medium tracking-wide uppercase" style={{ color: 'var(--ink-muted)' }}>
        Payments logged ({entries.length})
      </p>
      <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
        {entries.map(({ p, c }) => (
          <PaymentLogRow
            key={p.id}
            payment={p}
            card={c}
            loggedBy={p.created_by ? (profileNamesById[p.created_by] ?? null) : null}
            onChanged={onChanged}
          />
        ))}
      </div>
    </div>
  )
}

function PaymentLogRow({
  payment,
  card,
  loggedBy,
  onChanged,
}: {
  payment: SettlementPayment
  card: SettlementCard
  loggedBy: string | null
  onChanged: () => void
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirmDelete'>('view')
  const [kind, setKind] = useState<SettlementPaymentKind>(payment.kind)
  const [amount, setAmount] = useState(String(Math.round(payment.amount)))
  const [note, setNote] = useState(payment.note ?? '')
  const [busy, setBusy] = useState(false)

  const dateLabel = new Date(payment.created_at).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: '2-digit',
  })

  function resetForm() {
    setKind(payment.kind)
    setAmount(String(Math.round(payment.amount)))
    setNote(payment.note ?? '')
  }

  // The two paid-flags this card SHOULD carry once `nextPayments` is the
  // full payment set — recomputed from scratch (resolvedPaidFlags reports
  // both directions, unlike the insert path's monotonic settledPaidFlags)
  // and passed to the RPC, which sets them absolutely and re-syncs the
  // IPO's archived state.
  function flagsFor(nextPayments: SettlementPayment[]) {
    const { remainingFromHolder, remainingToFunder } = remainingFromPayments(card, nextPayments)
    return resolvedPaidFlags(card, remainingFromHolder, remainingToFunder)
  }

  async function saveEdit() {
    const amt = Number(amount)
    if (!amt || amt <= 0) {
      showToast('Enter an amount greater than 0.', 'warning')
      return
    }
    const next = card.payments.map((x) =>
      x.id === payment.id ? { ...x, kind, amount: amt, note: note.trim() || null } : x,
    )
    const flags = flagsFor(next)
    setBusy(true)
    const { error } = await supabase.rpc('update_settlement_payment', {
      p_id: payment.id,
      p_kind: kind,
      p_amount: amt,
      p_note: note.trim() || null,
      p_demat_cut_paid: flags.demat_cut_paid,
      p_funder_share_paid: flags.funder_share_paid,
    })
    setBusy(false)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    showToast('Payment updated.', 'good')
    setMode('view')
    onChanged()
  }

  async function confirmDelete() {
    const next = card.payments.filter((x) => x.id !== payment.id)
    const flags = flagsFor(next)
    setBusy(true)
    const { error } = await supabase.rpc('delete_settlement_payment', {
      p_id: payment.id,
      p_demat_cut_paid: flags.demat_cut_paid,
      p_funder_share_paid: flags.funder_share_paid,
    })
    setBusy(false)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    showToast('Payment deleted.', 'good')
    onChanged()
  }

  return (
    <div className="py-2 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <span style={{ color: 'var(--ink-primary)' }}>{PAYMENT_KIND_LABELS[payment.kind]}</span>
          <span style={{ color: 'var(--ink-muted)' }}>
            {' · '}
            {card.ipoName} · {card.holderName}
          </span>
        </div>
        <span className="font-mono-ipo shrink-0" style={{ color: 'var(--ink-primary)' }}>
          {rupees(payment.amount)}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
        <span>{dateLabel}</span>
        {loggedBy && <span>· by {loggedBy}</span>}
        {payment.note && <span>· {payment.note}</span>}
      </div>

      {mode === 'view' && (
        <div className="mt-1 flex gap-3">
          <button
            onClick={() => {
              resetForm()
              setMode('edit')
            }}
            className="link-accent text-xs font-medium"
          >
            Edit
          </button>
          <button
            onClick={() => setMode('confirmDelete')}
            className="text-xs font-medium hover:underline"
            style={{ color: 'var(--critical-text)' }}
          >
            Delete
          </button>
        </div>
      )}

      {mode === 'confirmDelete' && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span style={{ color: 'var(--ink-secondary)' }}>Delete this {rupees(payment.amount)} entry?</span>
          <button onClick={confirmDelete} disabled={busy} className="btn-primary text-xs disabled:opacity-50">
            {busy ? 'Deleting…' : 'Delete'}
          </button>
          <button onClick={() => setMode('view')} disabled={busy} className="btn-secondary text-xs disabled:opacity-50">
            Cancel
          </button>
        </div>
      )}

      {mode === 'edit' && (
        <div className="mt-2 space-y-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as SettlementPaymentKind)}
            className="input text-xs"
          >
            <option value="holder_to_admin">{PAYMENT_KIND_LABELS.holder_to_admin}</option>
            <option value="admin_to_funder">{PAYMENT_KIND_LABELS.admin_to_funder}</option>
            <option value="holder_to_funder">{PAYMENT_KIND_LABELS.holder_to_funder}</option>
          </select>
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
              placeholder="Note (optional)"
              className="input text-xs"
            />
          </div>
          <div className="flex gap-2">
            <button onClick={saveEdit} disabled={busy} className="btn-primary text-xs disabled:opacity-50">
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setMode('view')} disabled={busy} className="btn-secondary text-xs disabled:opacity-50">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
