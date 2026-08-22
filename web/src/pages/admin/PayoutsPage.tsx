// A dedicated, portal-wide view of every payout obligation from a SOLD
// application — the demat holder's cut, and the funder's 50/50 share when
// applicable — across every IPO at once, not just whichever one happens to
// be selected on the Allotment board. That page's "Sold status & payouts"
// section already does the per-IPO version of this; this page is the
// running ledger: what's still owed, to whom, and (once marked) a paid
// history — so nothing has to be reconstructed by memory or by clicking
// through every settled IPO one at a time.
import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDownIcon, SearchIcon } from '@primer/octicons-react'
import { supabase } from '../../lib/supabase'
import { useAllotmentBoardAll, queryKeys } from '../../lib/queries'
import { useAuth } from '../../contexts/AuthContext'
import { showToast } from '../../lib/toast'
import { computeProfitSplit } from '../../lib/profitSplit'
import { sendCustomWhatsapp } from '../../lib/dispatchWhatsapp'
import { payoutMessage, effectiveSplitWithFunder, payoutCutContact } from './AllotmentBoardPage'
import { sameIdentity } from '../../lib/applicationAttribution'
import { maybeAutoArchiveIpo } from '../../lib/autoArchive'
import { buildFunderAllottedCards, expectedProfitBreakdown, type ProfitProjectionRow } from '../../lib/expectedProfit'
import type { AllotmentBoardRow, SettlementPayment, SettlementPaymentKind } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

interface PayoutLine {
  applicationId: string
  field: 'demat_cut_paid' | 'funder_share_paid'
  kind: 'cut' | 'share'
  recipient: string
  phone: string | null
  ipoName: string
  amount: number
  paid: boolean
  row: AllotmentBoardRow
  result: ReturnType<typeof computeProfitSplit>
}

// Same per-line split logic AllotmentBoardPage's SoldBreakdown already
// uses, just run across every SOLD row instead of one IPO's worth — kept as
// a plain function here rather than imported, since the source there is a
// component-internal render step, not an exported helper.
function buildPayoutLines(rows: AllotmentBoardRow[], profitPersonName: string): PayoutLine[] {
  const lines: PayoutLine[] = []
  for (const r of rows) {
    if (r.sell_price == null) continue
    const result = computeProfitSplit({
      sellPricePerShare: r.sell_price,
      lotSize: r.lot_size,
      lots: r.lots,
      bidAmount: r.bid_amount ?? 0,
      // See the matching comment on Dashboard's buildPendingPayouts — a
      // funder-only viewer isn't linked to the demat account they funded,
      // so demat_accounts RLS silently blocks v_allotment_board's join to
      // it for that row and profit_share_percent comes back null, which
      // JS coerces to 0 and skips the holder's cut entirely. Admin (the
      // only caller of this specific function today) always has full
      // access via is_admin(), so this fallback is defensive here rather
      // than fixing an observed bug — kept consistent with the other two
      // call sites below, which a funder genuinely does hit now.
      cutPercent: r.profit_share_percent ?? 25,
      dematHolderName: r.holder_name,
      funderName: r.bank_account_holder_name,
      profitPersonName,
      splitWithFunder: effectiveSplitWithFunder(r, r.split_profit_with_funder),
    })
    if (!result.isDematHolderSelf && result.dematCutAmount > 0) {
      const cutContact = payoutCutContact(r)
      lines.push({
        applicationId: r.application_id,
        field: 'demat_cut_paid',
        kind: 'cut',
        recipient: cutContact.name,
        phone: cutContact.phone,
        ipoName: r.company_name,
        amount: result.dematCutAmount,
        paid: r.demat_cut_paid,
        row: r,
        result,
      })
    }
    if (result.funderShare > 0) {
      lines.push({
        applicationId: r.application_id,
        field: 'funder_share_paid',
        kind: 'share',
        recipient: r.bank_account_holder_name ?? 'Unknown',
        phone: r.bank_account_phone,
        ipoName: r.company_name,
        amount: result.funderShare,
        paid: r.funder_share_paid,
        row: r,
        result,
      })
    }
  }
  return lines
}

function rupees(n: number): string {
  const sign = n < 0 ? '−' : ''
  return `${sign}₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`
}

// The two-sided settlement for one SOLD application: what the account
// holder owes back (principal + all profit except their own cut — money
// COMING IN) and what's owed out to whoever funded it (their principal +
// their profit share, if any — money GOING OUT). Distinct from PayoutLine
// above, which only tracks the OUTGOING obligations already being marked
// paid/unpaid; this is a per-application view of the full picture (both
// directions at once).
//
// remainingFromHolder/remainingToFunder are the LIVE figures — the full
// amountFromHolder/amountToFunder owed, minus whatever settlement_payments
// rows have actually been logged against this application so far (see
// migration 0078). Can go negative if overpaid; shown as-is rather than
// clamped to 0, since an overpayment is worth noticing, not hiding.
interface SettlementCard {
  applicationId: string
  // Needed to re-run the auto-archive check after a payment settles the
  // last outstanding side of this application — an IPO archives only once
  // nothing is left pending across all of its rows.
  ipoId: string
  ipoName: string
  lots: number
  lotSize: number
  sellPrice: number
  bidAmount: number
  totalSoldAmount: number
  profitTotal: number
  cutPercent: number
  holderName: string
  holderPhone: string | null
  isDematHolderSelf: boolean
  dematCutAmount: number
  // Money coming IN — what the account holder sends back once they've sold.
  amountFromHolder: number
  hasFunder: boolean
  isFunderSelf: boolean
  funderName: string | null
  funderPhone: string | null
  funderShare: number
  // Money going OUT — what's owed to the funder (their principal + share).
  amountToFunder: number
  // What's actually left over for the profit person (you) once both sides
  // above have moved — incoming minus outgoing, from computeProfitSplit
  // directly rather than re-derived, so it can never drift from the
  // authoritative split even if the two amounts above are ever adjusted.
  myProfit: number
  payments: SettlementPayment[]
  remainingFromHolder: number
  remainingToFunder: number
}

function buildSettlementCards(
  rows: AllotmentBoardRow[],
  profitPersonName: string,
  paymentsByApp: Map<string, SettlementPayment[]>,
): SettlementCard[] {
  const cards: SettlementCard[] = []
  for (const r of rows) {
    if (r.sell_price == null) continue
    const result = computeProfitSplit({
      sellPricePerShare: r.sell_price,
      lotSize: r.lot_size,
      lots: r.lots,
      bidAmount: r.bid_amount ?? 0,
      // See the comment on Dashboard's buildPendingPayouts — a funder-only
      // viewer's own copy of this row has profit_share_percent nulled out
      // by demat_accounts RLS (they're not linked to the account they
      // funded), which without this fallback silently skipped the demat
      // holder's cut and inflated their own settlement figures.
      cutPercent: r.profit_share_percent ?? 25,
      dematHolderName: r.holder_name,
      funderName: r.bank_account_holder_name,
      profitPersonName,
      splitWithFunder: effectiveSplitWithFunder(r, r.split_profit_with_funder),
    })
    const bidAmount = r.bid_amount ?? 0
    const amountFromHolder = result.isDematHolderSelf ? 0 : result.totalSoldAmount - result.dematCutAmount
    // A CASE_2 shared account's "funder" IS its manager (same person as the
    // holder-side cut recipient, migration 0079) — their bidAmount return is
    // already folded into amountFromHolder above (bidAmount + their share of
    // the remainder, via effectiveSplitWithFunder forcing funderShare to 0).
    // Without this, hasFunder/isFunderSelf would still see a distinct bank
    // account and wrongly add a SECOND "owed to funder" line for the same
    // bidAmount that's already inside amountFromHolder.
    const amountToFunder =
      r.account_manager_case_type === 'CASE_2'
        ? 0
        : result.hasFunder && !result.isFunderSelf
          ? bidAmount + result.funderShare
          : 0
    const cutContact = payoutCutContact(r)
    const payments = paymentsByApp.get(r.application_id) ?? []
    // A holder_to_funder payment reduces BOTH sides at once — it's money
    // that left the holder's pocket (counts against what they still owe)
    // AND money the funder now has (counts against what's still owed to
    // them) — it just never passed through you.
    const paidByHolder = payments
      .filter((p) => p.kind === 'holder_to_admin' || p.kind === 'holder_to_funder')
      .reduce((s, p) => s + p.amount, 0)
    const sentToFunder = payments
      .filter((p) => p.kind === 'admin_to_funder' || p.kind === 'holder_to_funder')
      .reduce((s, p) => s + p.amount, 0)
    cards.push({
      applicationId: r.application_id,
      ipoId: r.ipo_id,
      ipoName: r.company_name,
      lots: r.lots,
      lotSize: r.lot_size,
      sellPrice: r.sell_price,
      bidAmount,
      totalSoldAmount: result.totalSoldAmount,
      profitTotal: result.grossProfit,
      // Display-only field (the "Show calculation" breakdown text) — same
      // fallback as the computeProfitSplit call above, so the number shown
      // always matches what dematCutAmount was actually computed from.
      cutPercent: r.profit_share_percent ?? 25,
      holderName: cutContact.name,
      holderPhone: cutContact.phone,
      isDematHolderSelf: result.isDematHolderSelf,
      dematCutAmount: result.dematCutAmount,
      amountFromHolder,
      hasFunder: result.hasFunder,
      isFunderSelf: result.isFunderSelf,
      funderName: r.bank_account_holder_name,
      funderPhone: r.bank_account_phone,
      funderShare: result.funderShare,
      amountToFunder,
      myProfit: result.profitPersonShare,
      payments,
      remainingFromHolder: amountFromHolder - paidByHolder,
      remainingToFunder: amountToFunder - sentToFunder,
    })
  }
  return cards
}

interface RecipientGroup {
  name: string
  phone: string | null
  lines: PayoutLine[]
  total: number
}

function groupByRecipient(lines: PayoutLine[]): RecipientGroup[] {
  const byName = new Map<string, RecipientGroup>()
  for (const l of lines) {
    if (!byName.has(l.recipient)) byName.set(l.recipient, { name: l.recipient, phone: l.phone, lines: [], total: 0 })
    const g = byName.get(l.recipient)!
    if (!g.phone && l.phone) g.phone = l.phone
    g.lines.push(l)
    g.total += l.amount
  }
  return Array.from(byName.values()).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

interface SettlementPartyGroup {
  name: string
  phone: string | null
  total: number
  ipos: { ipoName: string; amount: number }[]
}

// Below a rupee, a card's remaining amount is just floating-point noise from
// the split math (halves/percentages), not a real outstanding balance — used
// as the threshold everywhere "still owed" is checked so a fully-settled
// card never shows up as a stray ₹0.4 entry.
const SETTLED_EPSILON = 1

// One row per real person still owed money in a given direction — "who do I
// need to send, how much, for which IPOs" and the mirror "who do I still
// need to collect from" — grouped from the live remainingToFunder/
// remainingFromHolder figures (not the gross totals), so a fully-paid
// application drops out entirely rather than still listing a ₹0 line.
function groupSettlementByParty(
  cards: SettlementCard[],
  side: 'funder' | 'holder',
): SettlementPartyGroup[] {
  const byName = new Map<string, SettlementPartyGroup>()
  for (const c of cards) {
    const name = side === 'funder' ? c.funderName : c.holderName
    const phone = side === 'funder' ? c.funderPhone : c.holderPhone
    const remaining = side === 'funder' ? c.remainingToFunder : c.remainingFromHolder
    const applicable = side === 'funder' ? c.hasFunder && !c.isFunderSelf : !c.isDematHolderSelf
    if (!applicable || !name || remaining <= SETTLED_EPSILON) continue
    if (!byName.has(name)) byName.set(name, { name, phone, total: 0, ipos: [] })
    const g = byName.get(name)!
    if (!g.phone && phone) g.phone = phone
    g.total += remaining
    g.ipos.push({ ipoName: c.ipoName, amount: remaining })
  }
  return Array.from(byName.values()).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

// Same SettlementPartyGroup shape as groupSettlementByParty above (so it
// can reuse the same SettlementPartyList component) but for the ESTIMATED
// allotted-not-yet-sold projection instead of the real settlement ledger —
// amountToReturn is expectedProfitBreakdown's "principal + this funder's
// own profit share," i.e. the same total groupSettlementByParty's
// remainingToFunder represents, just projected instead of confirmed.
function groupExpectedByFunder(
  cards: ReturnType<typeof buildFunderAllottedCards>,
  livePriceBySymbol: Record<string, number | null>,
): SettlementPartyGroup[] {
  const byName = new Map<string, SettlementPartyGroup>()
  for (const c of cards) {
    const livePrice = c.symbol ? (livePriceBySymbol[c.symbol] ?? null) : null
    const amount = expectedProfitBreakdown(c, livePrice).amountToReturn
    if (amount <= 0) continue
    if (!byName.has(c.funderName)) byName.set(c.funderName, { name: c.funderName, phone: c.phone, total: 0, ipos: [] })
    const g = byName.get(c.funderName)!
    if (!g.phone && c.phone) g.phone = c.phone
    g.total += amount
    g.ipos.push({ ipoName: c.ipoName, amount })
  }
  return Array.from(byName.values()).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

// Both directions of an application's own obligations done — the holder's
// side (if there was one to begin with) and the funder's side (ditto). A
// self-funded or self-held application is trivially "settled" on the side
// that never applied to it in the first place.
function isCardFullySettled(c: SettlementCard): boolean {
  const holderDone = c.isDematHolderSelf || c.amountFromHolder <= 0 || c.remainingFromHolder <= SETTLED_EPSILON
  const funderDone = !c.hasFunder || c.isFunderSelf || c.amountToFunder <= 0 || c.remainingToFunder <= SETTLED_EPSILON
  return holderDone && funderDone
}

// Which of the two legacy paid-flags on `applications` a settlement state
// implies. The flags predate the settlement_payments ledger (0078 replaced
// the "one lump payment, all-or-nothing" model they encode) but are still
// what the Dashboard's "Payouts pending" tile, this page's Outstanding/Paid
// sections, and auto-archive all read — so logging enough payments to clear
// a side has to flip the matching flag, or those three keep insisting money
// is owed that the ledger already shows as received.
//
// Deliberately only ever reports true. Payments are append-only (there's no
// delete in the UI), so a remaining balance only ever decreases and a flag
// only ever needs to go unpaid -> paid; nothing here should un-mark a flag
// an admin set by hand.
//
// Takes the remaining amounts as arguments rather than reading them off the
// card, so the caller can pass post-payment figures for a payment that
// hasn't been re-fetched yet.
function settledPaidFlags(
  c: SettlementCard,
  remainingFromHolder: number,
  remainingToFunder: number,
): { demat_cut_paid?: true; funder_share_paid?: true } {
  const flags: { demat_cut_paid?: true; funder_share_paid?: true } = {}
  if (!c.isDematHolderSelf && c.amountFromHolder > 0 && remainingFromHolder <= SETTLED_EPSILON) {
    flags.demat_cut_paid = true
  }
  if (c.hasFunder && !c.isFunderSelf && c.amountToFunder > 0 && remainingToFunder <= SETTLED_EPSILON) {
    flags.funder_share_paid = true
  }
  return flags
}

interface IpoSettlementGroup {
  ipoName: string
  cards: SettlementCard[]
  allSettled: boolean
}

// One entry per IPO, not per application — the page used to list every sold
// application as its own flat card regardless of which IPO it belonged to,
// which meant the same IPO's several holders/funders scattered across the
// grid instead of reading as one settlement job. Grouped + sorted with any
// still-outstanding IPO first, so the ones needing action surface above the
// fully-settled ones rather than being interleaved by application id order.
function groupCardsByIpo(cards: SettlementCard[]): IpoSettlementGroup[] {
  const byIpo = new Map<string, SettlementCard[]>()
  for (const c of cards) {
    if (!byIpo.has(c.ipoName)) byIpo.set(c.ipoName, [])
    byIpo.get(c.ipoName)!.push(c)
  }
  return Array.from(byIpo.entries())
    .map(([ipoName, ipoCards]) => ({ ipoName, cards: ipoCards, allSettled: ipoCards.every(isCardFullySettled) }))
    .sort((a, b) => Number(a.allSettled) - Number(b.allSettled) || a.ipoName.localeCompare(b.ipoName))
}

export function PayoutsPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const queryClient = useQueryClient()
  // Shared cache (lib/queries.ts) — v_allotment_board is also read in full
  // by Dashboard, and filtered differently by Archives and the Allotment
  // board; this page's own SOLD-only, not-archived view is a client-side
  // filter over the same cached rows instead of its own separate
  // `.eq('status', 'SOLD')` network query. It's backed by `applications`,
  // which IS in the realtime publication (CLAUDE.md) — RealtimeCacheSync
  // (mounted once in App.tsx) invalidates this cache on any applications
  // change from anywhere in the app, not just from this page.
  const boardQuery = useAllotmentBoardAll()
  const rows = useMemo(
    () => (boardQuery.data ?? []).filter((r) => r.status === 'SOLD' && !r.ipo_is_archived),
    [boardQuery.data],
  )
  const [payments, setPayments] = useState<SettlementPayment[]>([])
  const [localLoading, setLocalLoading] = useState(true)
  const loading = boardQuery.isPending || localLoading
  const [loadError, setLoadError] = useState<string | null>(null)
  const [markingPaid, setMarkingPaid] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // Admin-only, separate from the SOLD settlement ledger above — allotted
  // applications that haven't been marked SOLD yet still have real money
  // owed to whoever funded them once they do sell, and there was no way to
  // see who/how much until that point without checking every IPO by hand.
  // Estimated (live price when the IPO's listed and its symbol is on file,
  // GMP-based projection otherwise, same fallback expectedProfitBreakdown
  // already uses for Dashboard's "Expected profit" tile) — never a
  // confirmed figure, so kept entirely separate from the real settlement
  // cards above rather than blended into the same total.
  const [expectedCards, setExpectedCards] = useState<ReturnType<typeof buildFunderAllottedCards>>([])
  const [livePriceBySymbol, setLivePriceBySymbol] = useState<Record<string, number | null>>({})

  async function load() {
    setLocalLoading(true)
    setLoadError(null)
    // Board rows come from the shared v_allotment_board cache (above) —
    // invalidate it here too (not just wait on RealtimeCacheSync's own
    // applications listener) so a mutation made from THIS page reflects
    // immediately rather than however long the realtime round trip takes.
    queryClient.invalidateQueries({ queryKey: queryKeys.allotmentBoard })
    const [paymentsRes, expectedRes, case2ManagersRes] = await Promise.all([
      supabase.from('settlement_payments').select('*').order('created_at', { ascending: false }),
      // Same shape/query NotificationsPage's admin funder query and
      // Dashboard's profit-projection query already use — admin-only
      // conceptually (this section only ever renders for isAdmin below),
      // but not client-gated on the fetch itself per this app's own
      // convention of letting RLS do the scoping rather than an
      // isAdmin ? ... : [] branch pretending to be the security boundary.
      supabase
        .from('applications')
        .select(
          'ipo_id, lots, applied_at, status, mandate_status, ipoji_status_text, bid_amount, sell_price, split_profit_with_funder, ' +
            'ipos(company_name, open_date, close_date, listing_date, price_high, lot_size, gmp_notes, is_archived, symbol), ' +
            'demat_accounts(holder_name, profit_share_percent, phone_e164, account_manager_id), ' +
            'bank_accounts!bank_account_id(account_holder_name, phone_e164, upi_id), ' +
            'funder_override:bank_accounts!funder_override_id(account_holder_name, phone_e164, upi_id)',
        )
        .eq('status', 'ALLOTTED')
        .or('bank_account_id.not.is.null,funder_override_id.not.is.null'),
      // See DashboardPage's matching query — CASE_2 shared-account managers
      // shouldn't have their expected remainder halved with a nonexistent
      // third-party funder.
      supabase.from('account_managers').select('id').eq('case_type', 'CASE_2'),
    ])
    // Not fatal on its own — the page still works with the pre-existing
    // paid/unpaid flags below, just without the live remaining-amount
    // figures on each settlement card.
    if (paymentsRes.error) showToast(`Couldn't load settlement payments: ${paymentsRes.error.message}`, 'warning')
    setPayments((paymentsRes.data as SettlementPayment[]) ?? [])

    if (expectedRes.error) {
      showToast(`Couldn't load expected payouts: ${expectedRes.error.message}`, 'warning')
      setExpectedCards([])
      setLivePriceBySymbol({})
    } else {
      const expectedRowsBase = ((expectedRes.data ?? []) as unknown as ProfitProjectionRow[]).filter(
        (r) => !r.ipos?.is_archived,
      )
      const case2ManagerIds = new Set((case2ManagersRes.data ?? []).map((m) => m.id as string))
      const cards = buildFunderAllottedCards(expectedRowsBase, sameIdentity, case2ManagerIds).filter((c) => c.priceHigh)
      setExpectedCards(cards)
      const symbols = Array.from(new Set(cards.map((c) => c.symbol).filter((s): s is string => !!s)))
      if (symbols.length > 0) {
        const { data: priceData } = await supabase.functions.invoke<{
          prices?: Record<string, { price: number | null; stale: boolean }>
        }>('fetch-stock-price', { body: { symbols } })
        const prices: Record<string, number | null> = {}
        for (const [sym, p] of Object.entries(priceData?.prices ?? {})) prices[sym] = p.price
        setLivePriceBySymbol(prices)
      } else {
        setLivePriceBySymbol({})
      }
    }
    setLocalLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function markPaid(line: PayoutLine) {
    setMarkingPaid(line.applicationId + line.field)
    const { error } = await supabase
      .from('applications')
      .update({ [line.field]: true })
      .eq('id', line.applicationId)
    setMarkingPaid(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    load()
  }

  const paymentsByApp = new Map<string, SettlementPayment[]>()
  for (const p of payments) {
    if (!paymentsByApp.has(p.application_id)) paymentsByApp.set(p.application_id, [])
    paymentsByApp.get(p.application_id)!.push(p)
  }
  // profitPersonName is '' for a non-admin, not their own name — see the
  // long comment on Dashboard's equivalent buildPendingPayouts call for
  // why: computeProfitSplit (inside buildSettlementCards) uses this to
  // detect "is the funder ALSO the profit-taking admin," and a funder's
  // own name here would spuriously match their own row, zeroing what
  // they're owed. A non-admin viewer is never the profit-taking admin by
  // construction.
  const settlementCards = buildSettlementCards(rows, isAdmin ? (profile?.full_name ?? '') : '', paymentsByApp)
  const ipoSettlementGroups = groupCardsByIpo(settlementCards)

  if (!isAdmin) {
    // rows (v_allotment_board, SOLD only) is already RLS-scoped to just
    // this funder's own applications — no separate fetch/filter needed,
    // same settlementCards/ipoSettlementGroups the admin view uses, just
    // read-only (no log-a-payment control — settlement_payments writes are
    // genuinely admin-only at the RLS level) and without the cross-funder
    // "You need to send"/old boolean-flag sections that are an admin's own
    // management concern, not something a funder needs.
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            Your payouts
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            What you're owed on applications you've funded that have already sold.
          </p>
        </div>
        {loading ? (
          <InlineSpinner />
        ) : ipoSettlementGroups.length === 0 ? (
          <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
            Nothing sold yet on an application you've funded.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {ipoSettlementGroups.map((g) => (
              <IpoSettlementCard key={g.ipoName} group={g} onLogged={load} readOnly />
            ))}
          </div>
        )}
      </div>
    )
  }

  const allLines = buildPayoutLines(rows, profile?.full_name ?? '')
  const outstandingLines = allLines.filter((l) => !l.paid)
  const paidLines = allLines.filter((l) => l.paid)
  const searchFilter = (g: RecipientGroup) => !search.trim() || g.name.toLowerCase().includes(search.trim().toLowerCase())
  const outstandingGroups = groupByRecipient(outstandingLines).filter(searchFilter)
  const paidGroups = groupByRecipient(paidLines).filter(searchFilter)
  const outstandingTotal = outstandingLines.reduce((s, l) => s + l.amount, 0)

  // Live figures — what's ACTUALLY still outstanding right now, after every
  // logged settlement_payments row, not the gross pre-payment totals. This
  // is the headline "how much do I still need to send to funders" number.
  const totalStillFromHolder = settlementCards.reduce((s, c) => s + Math.max(0, c.remainingFromHolder), 0)
  const totalStillToFunder = settlementCards.reduce((s, c) => s + Math.max(0, c.remainingToFunder), 0)
  const totalMyProfit = settlementCards.reduce((s, c) => s + c.myProfit, 0)
  const owedToFunders = groupSettlementByParty(settlementCards, 'funder')
  const owedFromHolders = groupSettlementByParty(settlementCards, 'holder')
  const expectedByFunder = groupExpectedByFunder(expectedCards, livePriceBySymbol)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            Payouts
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {outstandingLines.length} outstanding
            {outstandingLines.length > 0 && ` (₹${Math.round(outstandingTotal).toLocaleString('en-IN')})`}.
          </p>
        </div>
        {/* Adjacent to the header text, not its own full-width row — the
            overall picture across every sold application at a glance. These
            are the LIVE remaining figures (after settlement_payments), not
            the gross totals — "Still to send" is what actually still needs
            moving out of your own pocket right now. */}
        {settlementCards.length > 0 && (
          <div className="card flex shrink-0 items-center gap-4 px-4 py-2.5 text-sm">
            <div>
              <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                Still owed to you
              </p>
              <p className="font-mono-ipo font-semibold" style={{ color: 'var(--good)' }}>
                {rupees(totalStillFromHolder)}
              </p>
            </div>
            <div>
              <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                Still to send funders
              </p>
              <p className="font-mono-ipo font-semibold" style={{ color: 'var(--critical-text)' }}>
                {rupees(totalStillToFunder)}
              </p>
            </div>
            <div>
              <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                My profit
              </p>
              <p className="font-mono-ipo font-semibold" style={{ color: 'var(--ink-primary)' }}>
                {rupees(totalMyProfit)}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Who, not just how much — the header tiles above give the two grand
          totals, but paying someone means knowing WHICH funder and HOW MUCH
          each one specifically, not one lump sum. Same for collecting: which
          holder still owes you, across which IPOs. Person drops off either
          list entirely once fully settled (SETTLED_EPSILON), rather than
          sticking around as a stray ₹0 row. */}
      {(owedToFunders.length > 0 || owedFromHolders.length > 0) && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <SettlementPartyList
            title="You need to send"
            groups={owedToFunders}
            amountColor="var(--critical-text)"
            emptyLabel="Nothing owed to any funder right now."
          />
          <SettlementPartyList
            title="You need to receive"
            groups={owedFromHolders}
            amountColor="var(--good)"
            emptyLabel="Nothing outstanding from any account holder right now."
          />
        </div>
      )}

      {/* Allotted but not yet sold — nothing confirmed to owe here, but
          knowing roughly who to prepare to pay (and how much) before it
          actually sells is the whole point: same math Dashboard's own
          "Expected profit" tile uses (live price once listed, GMP estimate
          before that), just grouped by funder like the confirmed section
          above instead of by IPO. Kept visually and structurally separate
          from "You need to send" — this is never a real, actionable
          obligation the way that section is. */}
      {expectedByFunder.length > 0 && (
        <div className="space-y-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            Expected — not yet sold
          </h2>
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            Estimated from the live share price where the IPO's listed and its symbol is on file, or the GMP
            projection otherwise — not a confirmed amount until it's actually marked sold.
          </p>
          <SettlementPartyList
            title="Expected to send"
            groups={expectedByFunder}
            amountColor="var(--ink-secondary)"
            emptyLabel="Nothing allotted-and-unsold with a funder right now."
            isEstimate
          />
        </div>
      )}

      {ipoSettlementGroups.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            Settlement — by IPO
          </h2>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {ipoSettlementGroups.map((g) => (
              <IpoSettlementCard key={g.ipoName} group={g} onLogged={load} />
            ))}
          </div>
        </section>
      )}

      {rows.length > 0 && (
        <div className="relative">
          <SearchIcon size={15} fill="var(--ink-muted)" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by recipient name…"
            className="input pl-9"
          />
        </div>
      )}

      {loadError && (
        <div className="card p-4 text-sm" style={{ borderColor: 'var(--critical)', color: 'var(--ink-primary)' }}>
          Couldn't load payouts: {loadError}
        </div>
      )}

      {loading ? (
        <InlineSpinner />
      ) : loadError ? null : (
        <>
          <PayoutSection
            title="Outstanding"
            emptyLabel={search ? `No outstanding payouts match "${search}".` : 'Nothing owed right now.'}
            groups={outstandingGroups}
            defaultOpen
            markingPaid={markingPaid}
            onMarkPaid={markPaid}
          />
          <PayoutSection
            title="Paid"
            emptyLabel={search ? `No paid payouts match "${search}".` : 'Nothing marked paid yet.'}
            groups={paidGroups}
            defaultOpen={false}
            markingPaid={markingPaid}
            onMarkPaid={markPaid}
          />
        </>
      )}
    </div>
  )
}

// One row per person, one line per IPO they're tied to within that row —
// same visual language as PayoutSection's recipient groups below (icon
// badge + name + total, IPOs listed underneath), just built off the live
// settlement figures instead of the paid/unpaid demat_cut_paid/
// funder_share_paid flags.
function SettlementPartyList({
  title,
  groups,
  amountColor,
  emptyLabel,
  isEstimate,
}: {
  title: string
  groups: SettlementPartyGroup[]
  amountColor: string
  emptyLabel: string
  // Changes the "Message" button's WhatsApp text from "current outstanding"
  // (a confirmed figure) to "expected, once sold" — sending someone a real
  // money message that implies a settled amount when it's actually just a
  // live-price/GMP projection would be actively misleading, not just
  // imprecise wording.
  isEstimate?: boolean
}) {
  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          {title}
        </h2>
        {groups.length > 0 && (
          <span className="font-mono-ipo text-sm font-semibold" style={{ color: amountColor }}>
            {rupees(groups.reduce((s, g) => s + g.total, 0))}
          </span>
        )}
      </div>
      {groups.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          {emptyLabel}
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.name} className="border-t pt-3 first:border-t-0 first:pt-0" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="icon-badge icon-badge-neutral shrink-0 text-xs font-semibold" style={{ width: '1.75rem', height: '1.75rem' }}>
                    {g.name[0]?.toUpperCase()}
                  </div>
                  <span className="text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                    {g.name}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {g.phone && (
                    <button
                      onClick={() =>
                        sendCustomWhatsapp(
                          g.phone!,
                          isEstimate
                            ? `Hi ${g.name}, rough estimate of what's expected across ${g.ipos.length} IPO${g.ipos.length === 1 ? '' : 's'} once sold: ${rupees(g.total)} — not confirmed yet.`
                            : `Hi ${g.name}, current outstanding across ${g.ipos.length} IPO${g.ipos.length === 1 ? '' : 's'}: ${rupees(g.total)}.`,
                        )
                      }
                      className="link-accent text-xs font-medium"
                    >
                      Message
                    </button>
                  )}
                  <span className="font-mono-ipo text-sm font-semibold" style={{ color: amountColor }}>
                    {rupees(g.total)}
                  </span>
                </div>
              </div>
              <div className="mt-1 space-y-0.5 pl-9">
                {g.ipos.map((i, idx) => (
                  <p key={idx} className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                    {i.ipoName} · {rupees(i.amount)}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const PAYMENT_KIND_LABELS: Record<SettlementPaymentKind, string> = {
  holder_to_admin: 'Holder paid you',
  admin_to_funder: 'You paid the funder',
  holder_to_funder: 'Holder paid the funder directly',
}

// One card per IPO — every sold application under it as a row (see
// SettlementCardView below), separated by dividers instead of each being
// its own top-level card. "Settled ✓" on the header once every row's both
// sides (holder owed you, you owed the funder) are fully paid — the whole
// point of grouping this way is that IPO-level state ("is this one done")
// is exactly what used to require scanning every application card by eye.
function IpoSettlementCard({
  group,
  onLogged,
  readOnly,
}: {
  group: IpoSettlementGroup
  onLogged: () => void
  // Funder's own view of their own settlement data — same cards, same
  // math, but no "+Log a payment" control: settlement_payments is
  // genuinely admin-only at the RLS level (p_settlement_payments_admin),
  // so a funder attempting to log one would just get a permission error.
  // Hiding the control is the correct read-only affordance, not a
  // workaround for a write that would fail anyway.
  readOnly?: boolean
}) {
  return (
    <div className="card stagger-item p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
          {group.ipoName}
        </p>
        {group.allSettled && <span className="badge badge-good shrink-0">Settled ✓</span>}
      </div>
      <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
        {group.cards.map((c) => (
          <SettlementCardView key={c.applicationId} c={c} onLogged={onLogged} readOnly={readOnly} />
        ))}
      </div>
    </div>
  )
}

// One row per sold application within an IpoSettlementCard — collapsed by
// default to just the two one-line summaries ("From X — need to receive
// ₹N" / "To Y — need to send ₹N"), with a "Show calculation" toggle that
// reveals the full breakdown (both colored blocks below, payment history,
// and the log-a-payment form) only when actually needed. Was its own
// always-expanded top-level .card per application — with several sold
// applications on the same IPO that meant scrolling through a wall of
// identical-looking math to find the one number that mattered (who to pay,
// how much), which is what this collapsed-by-default summary fixes.
function SettlementCardView({
  c,
  onLogged,
  readOnly,
}: {
  c: SettlementCard
  onLogged: () => void
  readOnly?: boolean
}) {
  const cutRemainder = c.profitTotal - c.dematCutAmount
  const [showDetails, setShowDetails] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [kind, setKind] = useState<SettlementPaymentKind>('holder_to_admin')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  // Defaults the amount field to whatever's still outstanding for the
  // selected kind's direction, so the common case (logging the full
  // remaining amount in one go) is a single tap rather than retyping a
  // number that's already on screen above.
  function selectKind(k: SettlementPaymentKind) {
    setKind(k)
    const suggested = k === 'admin_to_funder' || k === 'holder_to_funder' ? c.remainingToFunder : c.remainingFromHolder
    setAmount(suggested > 0 ? String(Math.round(suggested)) : '')
  }

  async function logPayment() {
    const amt = Number(amount)
    if (!amt || amt <= 0) {
      showToast('Enter an amount greater than 0.', 'warning')
      return
    }
    setSaving(true)
    const { error } = await supabase
      .from('settlement_payments')
      .insert({ application_id: c.applicationId, kind, amount: amt, note: note.trim() || null })
    if (error) {
      setSaving(false)
      showToast(error.message, 'critical')
      return
    }

    // What this payment leaves outstanding. Mirrors buildSettlementCards'
    // own two reducers: a holder_to_funder payment counts against BOTH
    // sides at once (it left the holder and reached the funder, it just
    // never passed through the admin), which is why these aren't exclusive.
    const nextFromHolder =
      c.remainingFromHolder - (kind === 'holder_to_admin' || kind === 'holder_to_funder' ? amt : 0)
    const nextToFunder =
      c.remainingToFunder - (kind === 'admin_to_funder' || kind === 'holder_to_funder' ? amt : 0)

    // Flip the legacy paid-flags for any side this payment just cleared, so
    // the Dashboard tile / Outstanding list / auto-archive stop reporting a
    // debt the ledger shows as settled. Done here rather than in a DB
    // trigger on settlement_payments because the amounts owed come out of
    // computeProfitSplit on the client — the database has no idea what
    // amountFromHolder/amountToFunder are, and reimplementing that split in
    // SQL is exactly the kind of duplicated math that drifts.
    const flags = settledPaidFlags(c, nextFromHolder, nextToFunder)
    if (Object.keys(flags).length > 0) {
      const { error: flagError } = await supabase.from('applications').update(flags).eq('id', c.applicationId)
      if (flagError) {
        // The payment itself is already saved and is the authoritative
        // record — surface the flag failure without discarding it, rather
        // than reporting the whole thing as failed.
        showToast(`Payment logged, but couldn't update paid status: ${flagError.message}`, 'warning')
      } else {
        // Settling the last side of the last unsettled row can be what makes
        // the whole IPO archivable, same check the Allotment board runs
        // after its own "Mark paid".
        await maybeAutoArchiveIpo(c.ipoId)
      }
    }

    setSaving(false)
    setAmount('')
    setNote('')
    setShowLog(false)
    onLogged()
  }

  // The holder's own side is fully settled once every rupee they owe has
  // actually been logged as received — either they paid you, or they paid
  // the funder directly (both count, same reasoning as remainingFromHolder
  // itself). Independent of whether the funder side is settled — a holder
  // can finish paying before you've forwarded it on, and this only ever
  // reflects the holder's own obligation. The funder mirror is the same
  // idea for the "To {funder} — need to send" line.
  //
  // Same helper logPayment writes the paid-flags from, so the "Settled ✓"
  // badge here and the flag the rest of the portal reads can't disagree.
  const settled = settledPaidFlags(c, c.remainingFromHolder, c.remainingToFunder)
  const holderSettled = settled.demat_cut_paid === true
  const funderSettled = settled.funder_share_paid === true

  return (
    <div className="stagger-item space-y-2 py-3 first:pt-0 last:pb-0">
      {/* Collapsed-by-default summary — the two numbers that actually
          matter (who to collect from, who to pay, how much) without
          needing to open the full calculation to find them. Either line
          can be absent (self-funded: no funder line; holder IS you: no
          holder line) or shown settled instead of an amount. */}
      <div className="space-y-1">
        {!c.isDematHolderSelf && c.amountFromHolder > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm" style={{ color: 'var(--ink-primary)' }}>
              From <span className="font-medium">{c.holderName}</span> — need to receive
            </p>
            {holderSettled ? (
              <span className="badge badge-good shrink-0">Settled ✓</span>
            ) : (
              <span className="font-mono-ipo text-sm font-semibold shrink-0" style={{ color: 'var(--good)' }}>
                {rupees(c.remainingFromHolder)}
              </span>
            )}
          </div>
        )}
        {c.hasFunder && !c.isFunderSelf && c.amountToFunder > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm" style={{ color: 'var(--ink-primary)' }}>
              To <span className="font-medium">{c.funderName}</span> — need to send
            </p>
            {funderSettled ? (
              <span className="badge badge-good shrink-0">Settled ✓</span>
            ) : (
              <span className="font-mono-ipo text-sm font-semibold shrink-0" style={{ color: 'var(--critical-text)' }}>
                {rupees(c.remainingToFunder)}
              </span>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowDetails((v) => !v)}
        className="link-accent text-xs font-medium"
      >
        {showDetails ? 'Hide calculation' : 'Show calculation'}
      </button>

      {showDetails && (
        <div className="space-y-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
      <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
        Sold {c.lotSize} share{c.lotSize === 1 ? '' : 's'} at {rupees(c.sellPrice)}/share
      </p>

      {!c.isDematHolderSelf && c.amountFromHolder > 0 && (
        <div className="rounded-lg border p-3 text-xs" style={{ borderColor: 'var(--good-tint)', background: 'var(--good-tint)' }}>
          <p className="mb-1.5 font-medium" style={{ color: 'var(--ink-primary)' }}>
            From {c.holderName} (account holder)
          </p>
          <div className="space-y-0.5" style={{ color: 'var(--ink-secondary)' }}>
            <p>Total sold: {rupees(c.totalSoldAmount)}</p>
            <p>Invested: {rupees(c.bidAmount)}</p>
            <p>
              Profit: {rupees(c.totalSoldAmount)} − {rupees(c.bidAmount)} = {rupees(c.profitTotal)}
            </p>
            <p className="pt-1">Their {c.cutPercent}% profit-sharing (incl. TAX) cut:</p>
            <p>
              {rupees(c.profitTotal)} × {c.cutPercent}% = {rupees(c.dematCutAmount)}
            </p>
            <p className="pt-1 font-medium" style={{ color: 'var(--good)' }}>
              Total to receive: {rupees(c.bidAmount)} + {rupees(cutRemainder)} = {rupees(c.amountFromHolder)}
            </p>
            {c.remainingFromHolder !== c.amountFromHolder && (
              <p className="pt-1 font-medium" style={{ color: c.remainingFromHolder > 0 ? 'var(--warning-text)' : 'var(--good)' }}>
                Still owed: {rupees(c.remainingFromHolder)}
                {c.remainingFromHolder < 0 && ' (overpaid)'}
              </p>
            )}
          </div>
        </div>
      )}

      {c.hasFunder && !c.isFunderSelf && c.amountToFunder > 0 && (
        <div
          className="rounded-lg border p-3 text-xs"
          style={{ borderColor: 'var(--critical-tint)', background: 'var(--critical-tint)' }}
        >
          <p className="mb-1.5 font-medium" style={{ color: 'var(--ink-primary)' }}>
            To {c.funderName} (funder)
          </p>
          <div className="space-y-0.5" style={{ color: 'var(--ink-secondary)' }}>
            <p>Their principal: {rupees(c.bidAmount)}</p>
            <p>Their profit share: {rupees(c.funderShare)}</p>
            <p className="pt-1 font-medium" style={{ color: 'var(--critical-text)' }}>
              Total to pay: {rupees(c.bidAmount)} + {rupees(c.funderShare)} = {rupees(c.amountToFunder)}
            </p>
            {c.remainingToFunder !== c.amountToFunder && (
              <p className="pt-1 font-medium" style={{ color: c.remainingToFunder > 0 ? 'var(--warning-text)' : 'var(--good)' }}>
                Still to send: {rupees(c.remainingToFunder)}
                {c.remainingToFunder < 0 && ' (overpaid)'}
              </p>
            )}
          </div>
        </div>
      )}

      <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
        My profit: <span style={{ color: 'var(--ink-primary)', fontWeight: 600 }}>{rupees(c.myProfit)}</span>
      </p>

      {c.payments.length > 0 && (
        <div className="space-y-1 border-t pt-2" style={{ borderColor: 'var(--border)' }}>
          {c.payments.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
              <span>
                {PAYMENT_KIND_LABELS[p.kind]}
                {p.note && ` — ${p.note}`}
              </span>
              <span className="font-mono-ipo shrink-0">{rupees(p.amount)}</span>
            </div>
          ))}
        </div>
      )}

      {!readOnly &&
        (c.amountFromHolder > 0 || c.amountToFunder > 0) &&
        (showLog ? (
          <div className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
            <select value={kind} onChange={(e) => selectKind(e.target.value as SettlementPaymentKind)} className="input text-xs">
              {c.amountFromHolder > 0 && <option value="holder_to_admin">{PAYMENT_KIND_LABELS.holder_to_admin}</option>}
              {c.amountToFunder > 0 && <option value="admin_to_funder">{PAYMENT_KIND_LABELS.admin_to_funder}</option>}
              {c.amountToFunder > 0 && <option value="holder_to_funder">{PAYMENT_KIND_LABELS.holder_to_funder}</option>}
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
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="input text-xs" />
            </div>
            <div className="flex gap-2">
              <button onClick={logPayment} disabled={saving} className="btn-primary text-xs disabled:opacity-50">
                {saving ? 'Logging…' : 'Log payment'}
              </button>
              <button onClick={() => setShowLog(false)} className="btn-secondary text-xs">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => {
              selectKind(c.amountFromHolder > 0 ? 'holder_to_admin' : 'admin_to_funder')
              setShowLog(true)
            }}
            className="link-accent text-xs font-medium"
          >
            + Log a payment
          </button>
        ))}
        </div>
      )}
    </div>
  )
}

function PayoutSection({
  title,
  emptyLabel,
  groups,
  defaultOpen,
  markingPaid,
  onMarkPaid,
}: {
  title: string
  emptyLabel: string
  groups: RecipientGroup[]
  defaultOpen: boolean
  markingPaid: string | null
  onMarkPaid: (line: PayoutLine) => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <h2 className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          <span className="inline-flex transition-transform duration-200" style={{ transform: open ? 'rotate(180deg)' : undefined }}>
            <ChevronDownIcon size={14} />
          </span>
          {title} <span style={{ color: 'var(--ink-muted)', fontWeight: 400 }}>({groups.length})</span>
        </h2>
      </button>
      {open &&
        (groups.length === 0 ? (
          <p className="card p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            {emptyLabel}
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.name} className="card stagger-item p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div
                      className="icon-badge icon-badge-good shrink-0 text-xs font-semibold"
                      style={{ width: '2rem', height: '2rem' }}
                    >
                      {g.name[0]?.toUpperCase()}
                    </div>
                    <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {g.name}
                    </span>
                  </div>
                  <span style={{ color: 'var(--good)' }}>₹{Math.round(g.total).toLocaleString('en-IN')}</span>
                </div>
                <div className="mt-2 space-y-1.5">
                  {g.lines.map((l) => (
                    <div key={l.applicationId + l.field} className="flex items-center justify-between gap-2 text-xs">
                      <span style={{ color: 'var(--ink-muted)' }}>
                        {l.ipoName} · {l.kind === 'cut' ? 'cut' : 'share'} · ₹{Math.round(l.amount).toLocaleString('en-IN')}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {l.phone && (
                          <button
                            onClick={() => sendCustomWhatsapp(l.phone!, payoutMessage(l.row, l.result, l.kind))}
                            className="link-accent font-medium"
                          >
                            Message
                          </button>
                        )}
                        {l.paid ? (
                          <span className="badge badge-good">Paid</span>
                        ) : (
                          <button
                            onClick={() => onMarkPaid(l)}
                            disabled={markingPaid === l.applicationId + l.field}
                            className="link-accent font-medium disabled:opacity-50"
                          >
                            {markingPaid === l.applicationId + l.field ? 'Marking…' : 'Mark paid'}
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
    </section>
  )
}
