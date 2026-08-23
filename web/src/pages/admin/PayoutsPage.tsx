// A dedicated, portal-wide view of every payout obligation from a SOLD
// application — the demat holder's cut, and the funder's 50/50 share when
// applicable — across every IPO at once, not just whichever one happens to
// be selected on the Allotment board. That page's "Sold status & payouts"
// section already does the per-IPO version of this; this page is the
// running ledger: what's still owed, to whom, and (once marked) a paid
// history — so nothing has to be reconstructed by memory or by clicking
// through every settled IPO one at a time.
import { useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDownIcon,
  SearchIcon,
  CreditCardIcon,
  ClockIcon,
  ChecklistIcon,
  PaperAirplaneIcon,
  CheckCircleFillIcon,
} from '@primer/octicons-react'
import { supabase } from '../../lib/supabase'
import { useAllotmentBoardAll, queryKeys } from '../../lib/queries'
import { useAuth } from '../../contexts/AuthContext'
import { showToast } from '../../lib/toast'
import { computeProfitSplit } from '../../lib/profitSplit'
import { sendCustomWhatsapp } from '../../lib/dispatchWhatsapp'
import { payoutMessage, effectiveSplitWithFunder, payoutCutContact } from './AllotmentBoardPage'
import { sameIdentity } from '../../lib/applicationAttribution'
import { maybeAutoArchiveIpo } from '../../lib/autoArchive'
import {
  buildFunderAllottedCards,
  buildUnrealizedProfitLines,
  expectedProfitBreakdown,
  type ProfitProjectionRow,
  type UnrealizedProfitLine,
} from '../../lib/expectedProfit'
import {
  buildSettlementCards,
  groupCardsByIpo,
  settledPaidFlags,
  SETTLED_EPSILON,
  type SettlementCard,
  type IpoSettlementGroup,
} from '../../lib/settlement'
import type { AllotmentBoardRow, SettlementPayment, SettlementPaymentKind } from '../../types/database'
import { InlineSpinner, Skeleton } from '../../components/PageSpinner'
import { InfoTooltip, HoverCard } from '../../components/HoverCard'
import { useCountUp } from '../../lib/useCountUp'
import {
  buildPayoutAnalytics,
  resolveDateRange,
  type DateRangePreset,
  type IpoBreakdownRow,
  type AccountPendingRow,
} from '../../lib/payoutAnalytics'
import { StatTile } from './DashboardPage'
import { nowIst } from '../../lib/ipoStatus'

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

// Module-level, not per-render — same reasoning as v1.186.0's other
// stable-empty-fallback fixes (an inline `?? []`/`?? {}` allocates a fresh
// reference on every render while the query has no data yet, which is an
// unstable dependency for anything downstream that memoizes on it).
const EMPTY_PROJECTION_ROWS: ProfitProjectionRow[] = []
const EMPTY_LIVE_PRICES: Record<string, number | null> = {}
const EMPTY_CASE2_IDS: Set<string> = new Set()
const EMPTY_BOARD_ROWS: AllotmentBoardRow[] = []
const EMPTY_PAYMENTS: SettlementPayment[] = []

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

// Mirror of groupExpectedByFunder above, but for the account holder's own
// cut of an allotted-not-yet-sold application — the funder-card projection
// above can't attribute this precisely per holder (one card can cover
// several holders funded by the same person), so this reads straight off
// the per-application unrealizedLines instead, which already has an exact
// holderCut for each real application (see expectedProfit.ts's
// buildUnrealizedProfitLines).
function groupExpectedByHolder(lines: UnrealizedProfitLine[]): SettlementPartyGroup[] {
  const byName = new Map<string, SettlementPartyGroup>()
  for (const l of lines) {
    if (l.holderCut <= 0) continue
    if (!byName.has(l.holderName)) byName.set(l.holderName, { name: l.holderName, phone: l.holderPhone, total: 0, ipos: [] })
    const g = byName.get(l.holderName)!
    if (!g.phone && l.holderPhone) g.phone = l.holderPhone
    g.total += l.holderCut
    g.ipos.push({ ipoName: l.ipoName, amount: l.holderCut })
  }
  return Array.from(byName.values()).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

// Shown in place of the whole analytics dashboard while its data is still
// loading, instead of rendering the real cards immediately with every
// number at its empty-array default of 0 and then jumping to the true
// figure the instant the query resolves — that flash-then-jump was the
// actual bug being reported, not anything wrong with the numbers
// themselves. Shaped roughly like the real layout below (skeleton bars
// standing in for each card) so there's no layout shift once it's replaced.
function AnalyticsSkeleton() {
  return (
    <div className="space-y-5">
      <div className="card space-y-3 p-5">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-3 w-56" />
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <Skeleton className="h-16 rounded-2xl" />
        <Skeleton className="h-16 rounded-2xl" />
      </div>
      <Skeleton className="h-24 rounded-2xl" />
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-16 rounded-2xl" />
        <Skeleton className="h-16 rounded-2xl" />
      </div>
      <Skeleton className="h-40 rounded-2xl" />
    </div>
  )
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
  const [markingPaid, setMarkingPaid] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  // Everything below that ISN'T the shared v_allotment_board cache
  // (settlement_payments, the ALLOTTED-with-embeds projection query, and
  // the live stock-price lookup derived from it) — was a local useState +
  // manual load() called once on mount, reset to loading=true on every
  // visit to this page exactly like Dashboard's own data was before
  // v1.183.0. One useQuery instead, so revisiting Payouts within
  // staleTime is an instant cache hit instead of a spinner over data that
  // was already on screen a moment ago.
  interface LocalPayoutsData {
    payments: SettlementPayment[]
    // Admin-only, separate from the SOLD settlement ledger above — allotted
    // applications that haven't been marked SOLD yet still have real money
    // owed to whoever funded them once they do sell, and there was no way to
    // see who/how much until that point without checking every IPO by hand.
    // Estimated (live price when the IPO's listed and its symbol is on file,
    // GMP-based projection otherwise, same fallback expectedProfitBreakdown
    // already uses for Dashboard's "Expected profit" tile) — never a
    // confirmed figure, so kept entirely separate from the real settlement
    // cards above rather than blended into the same total.
    expectedCards: ReturnType<typeof buildFunderAllottedCards>
    livePriceBySymbol: Record<string, number | null>
    // ALL statuses, ALL applications (not just ALLOTTED-with-a-tracked-
    // funder like expectedRes below) — the one thing the pre-existing
    // settlement/expected-payout queries never needed and the new
    // analytics dashboard does: "how many applications, how much invested,
    // how many shares allotted, across every status, this period." Same
    // ProfitProjectionRow shape (id + status_changed_at added, both needed
    // to key a line to its own application and to a realization date —
    // see lib/expectedProfit.ts's own note on both fields).
    allRows: ProfitProjectionRow[]
    case2ManagerIds: Set<string>
  }
  const localPayoutsQuery = useQuery<LocalPayoutsData>({
    queryKey: ['payouts-local'],
    queryFn: async () => {
      const [paymentsRes, expectedRes, case2ManagersRes, allRowsRes] = await Promise.all([
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
        // Broader than expectedRes above: every status (not just ALLOTTED),
        // no funder-existence filter (self-funded applications count too
        // for "how much invested"/"how many applications" this period).
        supabase
          .from('applications')
          .select(
            'id, ipo_id, lots, applied_at, status, status_changed_at, mandate_status, ipoji_status_text, bid_amount, sell_price, split_profit_with_funder, ' +
              'ipos(company_name, open_date, close_date, listing_date, price_high, lot_size, gmp_notes, is_archived, symbol), ' +
              'demat_accounts(holder_name, profit_share_percent, phone_e164, account_manager_id), ' +
              'bank_accounts!bank_account_id(account_holder_name, phone_e164, upi_id), ' +
              'funder_override:bank_accounts!funder_override_id(account_holder_name, phone_e164, upi_id)',
          ),
      ])
      // Not fatal on its own — the page still works with the pre-existing
      // paid/unpaid flags below, just without the live remaining-amount
      // figures on each settlement card. Warned via toast rather than
      // thrown, same as before — a thrown error here would put the WHOLE
      // query into error state and blank the page, which is worse than
      // just missing the live-remaining figures.
      if (paymentsRes.error) showToast(`Couldn't load settlement payments: ${paymentsRes.error.message}`, 'warning')
      const payments = (paymentsRes.data as SettlementPayment[]) ?? []

      if (allRowsRes.error) showToast(`Couldn't load applications for analytics: ${allRowsRes.error.message}`, 'warning')
      const allRows = ((allRowsRes.data ?? []) as unknown as ProfitProjectionRow[]).filter((r) => !r.ipos?.is_archived)

      if (expectedRes.error) {
        showToast(`Couldn't load expected payouts: ${expectedRes.error.message}`, 'warning')
        return { payments, expectedCards: [], livePriceBySymbol: {}, allRows, case2ManagerIds: new Set<string>() }
      }
      const expectedRowsBase = ((expectedRes.data ?? []) as unknown as ProfitProjectionRow[]).filter(
        (r) => !r.ipos?.is_archived,
      )
      const case2ManagerIds = new Set((case2ManagersRes.data ?? []).map((m) => m.id as string))
      const expectedCards = buildFunderAllottedCards(expectedRowsBase, sameIdentity, case2ManagerIds).filter((c) => c.priceHigh)
      // Symbols from BOTH the funder-card projection and the broader
      // allRows set — allRows' own ALLOTTED rows feed buildUnrealizedProfitLines
      // (the analytics dashboard's unrealized-profit figure), which needs
      // the same live-price lookup expectedCards already triggers, not a
      // second round trip to the same Edge Function.
      const symbols = Array.from(
        new Set([
          ...expectedCards.map((c) => c.symbol).filter((s): s is string => !!s),
          ...allRows.filter((r) => r.status === 'ALLOTTED').map((r) => r.ipos?.symbol).filter((s): s is string => !!s),
        ]),
      )
      let livePriceBySymbol: Record<string, number | null> = {}
      if (symbols.length > 0) {
        const { data: priceData } = await supabase.functions.invoke<{
          prices?: Record<string, { price: number | null; stale: boolean }>
        }>('fetch-stock-price', { body: { symbols } })
        for (const [sym, p] of Object.entries(priceData?.prices ?? {})) livePriceBySymbol[sym] = p.price
      }
      return { payments, expectedCards, livePriceBySymbol, allRows, case2ManagerIds }
    },
  })
  const payments = localPayoutsQuery.data?.payments ?? EMPTY_PAYMENTS
  const expectedCards = localPayoutsQuery.data?.expectedCards ?? []
  const livePriceBySymbol = localPayoutsQuery.data?.livePriceBySymbol ?? EMPTY_LIVE_PRICES
  const allRows = localPayoutsQuery.data?.allRows ?? EMPTY_PROJECTION_ROWS
  const case2ManagerIds = localPayoutsQuery.data?.case2ManagerIds ?? EMPTY_CASE2_IDS
  const loading = boardQuery.isPending || localPayoutsQuery.isPending
  const loadError = localPayoutsQuery.error instanceof Error ? localPayoutsQuery.error.message : null

  // Both queries this page reads from — called after any mutation so the
  // page reflects its own write immediately rather than waiting on
  // RealtimeCacheSync's realtime round trip (allotmentBoard) or the next
  // staleTime window (payouts-local).
  function invalidatePayoutsData() {
    queryClient.invalidateQueries({ queryKey: queryKeys.allotmentBoard })
    queryClient.invalidateQueries({ queryKey: ['payouts-local'] })
  }

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
    invalidatePayoutsData()
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
  const profitPersonName = isAdmin ? (profile?.full_name ?? '') : ''
  const settlementCards = buildSettlementCards(rows, profitPersonName, paymentsByApp)
  const ipoSettlementGroups = groupCardsByIpo(settlementCards)

  // --- Profit & Payout Analytics dashboard (v1.187.0) ---
  // Default period is This Month -> today, per spec. Everything below is
  // derived from buildPayoutAnalytics (lib/payoutAnalytics.ts), which
  // itself only ever calls INTO existing calculations (computeProfitSplit,
  // buildBookedProfitLines, buildUnrealizedProfitLines, buildSettlementCards)
  // rather than a second profit formula living in this file.
  const [rangePreset, setRangePreset] = useState<DateRangePreset>('this_month')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const todayIstStr = nowIst().dateStr
  const range = useMemo(
    () =>
      resolveDateRange(
        rangePreset,
        todayIstStr,
        rangePreset === 'custom' ? { start: customStart || todayIstStr, end: customEnd || todayIstStr } : undefined,
      ),
    [rangePreset, todayIstStr, customStart, customEnd],
  )
  const analytics = useMemo(
    () => buildPayoutAnalytics(allRows, boardQuery.data ?? EMPTY_BOARD_ROWS, payments, range, profitPersonName, case2ManagerIds, livePriceBySymbol),
    [allRows, boardQuery.data, payments, range, profitPersonName, case2ManagerIds, livePriceBySymbol],
  )
  const [ipoSort, setIpoSort] = useState<'profit' | 'roi' | 'investment' | 'latest'>('profit')
  const [payoutStatusFilter, setPayoutStatusFilter] = useState<'all' | 'paid' | 'pending'>('all')

  // Counts up from 0 on mount/change instead of snapping straight to the
  // number — same motion StatTile's own KPI tiles already use, extended to
  // this page's non-StatTile headline figures so the whole dashboard reads
  // as one consistent feel instead of some numbers animating and others
  // popping in abruptly. useCountUp itself no-ops (renders the real value
  // immediately) while analytics is still the empty-array default, so
  // there's nothing to animate FROM until real data exists — the loading
  // skeleton below covers that gap instead.
  const animatedTotalProfit = useCountUp(analytics.summary.totalProfit)
  const animatedRealizedProfit = useCountUp(analytics.summary.realizedProfit)
  const animatedUnrealizedProfit = useCountUp(analytics.summary.unrealizedProfit)
  const animatedPaid = useCountUp(analytics.payoutStatus.paid)
  const animatedPending = useCountUp(analytics.payoutStatus.pending)

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
              <IpoSettlementCard key={g.ipoName} group={g} onLogged={invalidatePayoutsData} readOnly />
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
  // Deliberately NOT analytics.unrealizedLines — that's scoped to whatever
  // date range is selected up top (This month by default), while
  // expectedCards/expectedByFunder above covers every currently-ALLOTTED
  // application regardless of range. Recomputing from allRows here (same
  // un-filtered set expectedRowsBase used to build expectedCards) keeps
  // both halves of this section on the same scope, so they stay comparable
  // side by side instead of silently disagreeing on which applications
  // they cover.
  const expectedByHolder = groupExpectedByHolder(
    buildUnrealizedProfitLines(
      allRows.filter((r) => r.status === 'ALLOTTED'),
      profitPersonName,
      livePriceBySymbol,
      case2ManagerIds,
    ),
  )

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

      {/* === Profit & Payout Analytics dashboard (v1.187.0) === */}
      <div className="space-y-5">
        <div className="flex flex-col items-start gap-2 text-sm sm:flex-row sm:items-center" style={{ color: 'var(--ink-muted)' }}>
          <span className="shrink-0">Range</span>
          <div className="segmented scrollbar-none max-w-full overflow-x-auto">
            {(
              [
                ['this_month', 'This month'],
                ['last_month', 'Last month'],
                ['last_3_months', 'Last 3 months'],
                ['this_year', 'This year'],
                ['all_time', 'All time'],
                ['custom', 'Custom'],
              ] as [DateRangePreset, string][]
            ).map(([preset, label]) => (
              <button
                key={preset}
                type="button"
                onClick={() => setRangePreset(preset)}
                className={`segmented-item shrink-0 whitespace-nowrap ${rangePreset === preset ? 'segmented-item-active' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
          {rangePreset === 'custom' && (
            <div className="flex items-center gap-1.5">
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="input text-xs" />
              <span style={{ color: 'var(--ink-muted)' }}>to</span>
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="input text-xs" />
            </div>
          )}
        </div>

        {loading ? (
          <AnalyticsSkeleton />
        ) : (
          <>
        {/* Profit Till Date — the single most important number on the page,
            per the design brief this was built against: visual hierarchy is
            Profit -> ROI -> Investment -> Payout -> Pending -> everything
            else below. Realized/unrealized are broken out immediately
            underneath so "combined" is never mistaken for "confirmed." Whole
            card is now the hover trigger (HoverCard wraps it), same "hover
            anywhere on the tile" convention Dashboard's own StatTile uses —
            not just a small (i) icon in the corner. */}
        <HoverCard
          tone="good"
          panel={
            <p style={{ color: 'var(--ink-secondary)' }}>
              Realized profit from applications you've marked SOLD, plus estimated profit from ones that are
              allotted but not yet sold, combined into one number. ROI is total profit divided by total invested.
            </p>
          }
        >
        <div className="card p-5">
          <p className="text-xs font-medium tracking-wide uppercase" style={{ color: 'var(--ink-muted)' }}>
            {range.label} · Profit till date
          </p>
          <div className="mt-1 flex flex-wrap items-baseline gap-3">
            <p className="font-mono-ipo text-4xl font-bold" style={{ color: 'var(--good)' }}>
              {rupees(animatedTotalProfit)}
            </p>
            <span className="badge badge-good">{analytics.summary.roi.toFixed(2)}% ROI</span>
          </div>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
            {rupees(analytics.summary.realizedProfit)} realized + {rupees(analytics.summary.unrealizedProfit)} estimated
            (allotted/still held)
          </p>
          {/* ROI dropped from this grid — already shown as the badge above,
              no need for it twice. */}
          <div className="mt-4 grid grid-cols-2 gap-3 border-t pt-3 sm:grid-cols-4" style={{ borderColor: 'var(--border)' }}>
            {[
              ['Investment', analytics.summary.totalInvested, 'var(--ink-primary)'],
              ['Profit', analytics.summary.totalProfit, 'var(--good)'],
              ['Payout received', analytics.summary.totalPayout, 'var(--accent)'],
              ['Pending', analytics.summary.pendingPayout, 'var(--warning-text)'],
            ].map(([label, amount, color]) => (
              <div key={label as string}>
                <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                  {label}
                </p>
                <p className="font-mono-ipo text-sm font-semibold" style={{ color: color as string }}>
                  {rupees(amount as number)}
                </p>
              </div>
            ))}
          </div>
        </div>
        </HoverCard>

        {/* KPI grid — StatTile is Dashboard's own component (exported for
            reuse rather than a second near-identical tile implementation).
            Applications/Shares allotted tiles removed per feedback — their
            numbers are still available via the analytics object below, just
            not worth their own top-of-page tiles. */}
        <div className="grid grid-cols-2 gap-2.5">
          <StatTile
            icon={CreditCardIcon}
            label="Successful IPOs"
            value={analytics.summary.successfulIpoCount}
            tone="good"
            panel={<SuccessfulIposPanel rows={analytics.ipoBreakdown} />}
          />
          <StatTile
            icon={CreditCardIcon}
            label="Pending payout"
            value={analytics.summary.pendingPayout}
            tone={analytics.summary.pendingPayout > 0 ? 'warning' : 'good'}
            format={(n) => rupees(n)}
            panel={<PendingByAccountPanel rows={analytics.pendingByAccount} />}
          />
        </div>

        {/* Realized vs Unrealized — one rectangle, three sections, divided by
            a border rather than three separate cards (per feedback) — still
            never blended into one number: the brief's "clearly distinguish
            so the user does not confuse estimated profit with actual
            payout" is met by the divider + separate labels, not by separate
            card shells. */}
        <div className="card grid grid-cols-1 divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0" style={{ borderColor: 'var(--border)' }}>
          <div className="p-4">
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              Realized
            </p>
            <p className="font-mono-ipo text-xl font-semibold" style={{ color: 'var(--good)' }}>
              {rupees(animatedRealizedProfit)}
            </p>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
              From shares actually sold
            </p>
          </div>
          <div className="p-4">
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              Unrealized (estimated)
            </p>
            <p className="font-mono-ipo text-xl font-semibold" style={{ color: 'var(--accent)' }}>
              {rupees(animatedUnrealizedProfit)}
            </p>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
              Allotted/still held — live price or GMP estimate
            </p>
          </div>
          <div className="p-4">
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              Total
            </p>
            <p className="font-mono-ipo text-xl font-semibold" style={{ color: 'var(--ink-primary)' }}>
              {rupees(animatedTotalProfit)}
            </p>
          </div>
        </div>

        {/* Payout status — this app's settlement_payments has no "Failed"/
            "Processing" state (a row is only ever created after money has
            already moved), so this is Paid/Pending only rather than
            fabricating states that don't exist here. Clicking a card
            filters the transaction table below. */}
        <div className="grid grid-cols-2 gap-3">
          <HoverCard
            tone="good"
            panel={
              <p style={{ color: 'var(--ink-secondary)' }}>
                Total of every settlement_payments row logged so far — a real, confirmed transfer, not an estimate.
                Click the card to filter the transaction table below to just these.
              </p>
            }
          >
            <button
              type="button"
              onClick={() => setPayoutStatusFilter((f) => (f === 'paid' ? 'all' : 'paid'))}
              className="card w-full p-4 text-left transition-colors hover:bg-[var(--hover-surface)]"
              style={payoutStatusFilter === 'paid' ? { borderColor: 'var(--good)' } : undefined}
            >
              <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                Paid
              </p>
              <p className="font-mono-ipo text-lg font-semibold" style={{ color: 'var(--good)' }}>
                {rupees(animatedPaid)}
              </p>
            </button>
          </HoverCard>
          <HoverCard
            tone="warning"
            panel={
              <p style={{ color: 'var(--ink-secondary)' }}>
                What's still owed to funders on already-SOLD applications, after subtracting every logged payment —
                the live settlement ledger, not a projection.
              </p>
            }
          >
            <button
              type="button"
              onClick={() => setPayoutStatusFilter((f) => (f === 'pending' ? 'all' : 'pending'))}
              className="card w-full p-4 text-left transition-colors hover:bg-[var(--hover-surface)]"
              style={payoutStatusFilter === 'pending' ? { borderColor: 'var(--warning)' } : undefined}
            >
              <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                Pending
              </p>
              <p className="font-mono-ipo text-lg font-semibold" style={{ color: 'var(--warning-text)' }}>
                {rupees(animatedPending)}
              </p>
            </button>
          </HoverCard>
        </div>

        {/* IPO-wise breakdown — overflow-x-auto lives on the table wrapper
            ONLY, not the whole card. Per the CSS overflow spec, setting
            overflow-x without an explicit overflow-y computes overflow-y to
            auto too, which was clipping the heading's hover panel (it pops
            open BELOW the heading, inside what used to be this same
            scroll-clipped box) — same bug on the Account performance card
            below. */}
        {analytics.ipoBreakdown.length > 0 && (
          <div className="card p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
                IPO-wise profit analysis
                <InfoTooltip text="One row per IPO you've applied to. 'est.' means it isn't sold yet — profit and payout status are projected from the live/GMP price, not confirmed." />
              </h2>
              <div className="segmented scrollbar-none max-w-full overflow-x-auto">
                {(
                  [
                    ['profit', 'Highest profit'],
                    ['roi', 'Highest ROI'],
                    ['investment', 'Investment'],
                  ] as [typeof ipoSort, string][]
                ).map(([sort, label]) => (
                  <button
                    key={sort}
                    type="button"
                    onClick={() => setIpoSort(sort)}
                    className={`segmented-item shrink-0 whitespace-nowrap ${ipoSort === sort ? 'segmented-item-active' : ''}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead style={{ color: 'var(--ink-muted)' }} className="text-left">
                <tr>
                  <th className="px-2 py-1.5 font-medium">IPO</th>
                  <th className="px-2 py-1.5 font-medium">Investment</th>
                  <th className="px-2 py-1.5 font-medium">Shares</th>
                  <th className="px-2 py-1.5 font-medium">Exit value</th>
                  <th className="px-2 py-1.5 font-medium">Profit</th>
                  <th className="px-2 py-1.5 font-medium">ROI</th>
                  <th className="px-2 py-1.5 font-medium">Payout</th>
                </tr>
              </thead>
              <tbody>
                {[...analytics.ipoBreakdown]
                  .sort((a, b) =>
                    ipoSort === 'profit'
                      ? b.profit - a.profit
                      : ipoSort === 'roi'
                        ? b.roi - a.roi
                        : b.investment - a.investment,
                  )
                  .map((r) => (
                    <tr key={r.ipoId} className="border-t" style={{ borderColor: 'var(--border)' }}>
                      <td className="px-2 py-2 font-medium" style={{ color: 'var(--ink-primary)' }}>
                        {r.ipoName}
                        {!r.isRealized && (
                          <span className="ml-1.5 badge badge-neutral text-[10px]" title="Still held — estimated, not confirmed">
                            est.
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2">{rupees(r.investment)}</td>
                      <td className="px-2 py-2">{r.allottedShares.toLocaleString('en-IN')}</td>
                      <td className="px-2 py-2">{r.exitValue > 0 ? rupees(r.exitValue) : '—'}</td>
                      <td className="px-2 py-2 font-medium" style={{ color: r.profit >= 0 ? 'var(--good)' : 'var(--critical)' }}>
                        {rupees(r.profit)}
                      </td>
                      <td className="px-2 py-2" style={{ color: r.roi >= 0 ? 'var(--good)' : 'var(--critical)' }}>
                        {r.roi.toFixed(1)}%
                      </td>
                      <td className="px-2 py-2">
                        <span
                          className={`badge ${r.payoutStatus === 'Paid' ? 'badge-good' : r.payoutStatus === 'Partial' ? 'badge-warning' : r.payoutStatus === 'Pending' ? 'badge-critical' : 'badge-neutral'}`}
                        >
                          {r.payoutStatus}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            </div>
          </div>
        )}

        {/* Best / worst */}
        {(analytics.best || analytics.worst) && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {analytics.best && (
              <div className="card p-4">
                <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                  🏆 Best performing
                </p>
                <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                  {analytics.best.ipoName}
                </p>
                <p className="font-mono-ipo text-sm" style={{ color: 'var(--good)' }}>
                  {rupees(analytics.best.profit)} · {analytics.best.roi.toFixed(1)}% ROI
                </p>
              </div>
            )}
            {analytics.worst && (
              <div className="card p-4">
                <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                  Lowest performing
                </p>
                <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                  {analytics.worst.ipoName}
                </p>
                <p className="font-mono-ipo text-sm" style={{ color: analytics.worst.profit >= 0 ? 'var(--warning-text)' : 'var(--critical)' }}>
                  {rupees(analytics.worst.profit)} · {analytics.worst.roi.toFixed(1)}% ROI
                </p>
              </div>
            )}
          </div>
        )}

        {/* Account-wise (funder) performance — names only, no phone/UPI/
            bank details, matching this app's existing convention of
            resolving just a display name for anyone who isn't the viewer
            themselves (see resolve_bank_holder_names). */}
        {analytics.accountBreakdown.length > 0 && (
          <div className="card p-4">
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
              Account performance
              <InfoTooltip text="Investment and profit totalled per funder, across every IPO they've funded — realized and estimated profit combined, same as the KPI cards above." />
            </h2>
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead style={{ color: 'var(--ink-muted)' }} className="text-left">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Account</th>
                  <th className="px-2 py-1.5 font-medium">Investment</th>
                  <th className="px-2 py-1.5 font-medium">Profit</th>
                  <th className="px-2 py-1.5 font-medium">ROI</th>
                  <th className="px-2 py-1.5 font-medium">Successful IPOs</th>
                </tr>
              </thead>
              <tbody>
                {analytics.accountBreakdown.map((a) => (
                  <tr key={a.funderName} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-2 py-2 font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {a.funderName}
                    </td>
                    <td className="px-2 py-2">{rupees(a.investment)}</td>
                    <td className="px-2 py-2" style={{ color: a.profit >= 0 ? 'var(--good)' : 'var(--critical)' }}>
                      {rupees(a.profit)}
                    </td>
                    <td className="px-2 py-2">{a.roi.toFixed(1)}%</td>
                    <td className="px-2 py-2">{a.successfulIpos}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}

        {/* Capital utilization — whole card is the hover trigger, same as
            Profit till date above. */}
        <HoverCard
          panel={
            <p style={{ color: 'var(--ink-secondary)' }}>
              How your total invested bid amount (this range) breaks down: still locked in allotted-not-yet-sold
              applications, vs. already released by marking something sold.
            </p>
          }
        >
        <div className="card p-4">
          <h2 className="mb-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            Capital utilization
          </h2>
          <div className="flex h-2.5 overflow-hidden rounded-full" style={{ background: 'var(--hover-surface)' }}>
            {analytics.capital.invested > 0 && (
              <>
                <div
                  className="h-full"
                  style={{
                    width: `${(analytics.capital.locked / analytics.capital.invested) * 100}%`,
                    background: 'var(--warning)',
                  }}
                  title="Locked"
                />
                <div
                  className="h-full"
                  style={{
                    width: `${(analytics.capital.released / analytics.capital.invested) * 100}%`,
                    background: 'var(--good)',
                  }}
                  title="Released"
                />
              </>
            )}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
            <div>
              <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                Invested
              </p>
              <p className="font-mono-ipo font-semibold" style={{ color: 'var(--ink-primary)' }}>
                {rupees(analytics.capital.invested)}
              </p>
            </div>
            <div>
              <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                Locked (still held)
              </p>
              <p className="font-mono-ipo font-semibold" style={{ color: 'var(--warning-text)' }}>
                {rupees(analytics.capital.locked)}
              </p>
            </div>
            <div>
              <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                Released (sold)
              </p>
              <p className="font-mono-ipo font-semibold" style={{ color: 'var(--good)' }}>
                {rupees(analytics.capital.released)}
              </p>
            </div>
          </div>
        </div>
        </HoverCard>

        {/* Performance insights — only ever built from real numbers already
            computed above (lib/payoutAnalytics.ts); never shown if empty. */}
        {analytics.insights.length > 0 && (
          <div className="card p-4">
            <h2 className="mb-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
              Your {range.label.toLowerCase()} performance
            </h2>
            <ul className="space-y-1.5 text-sm" style={{ color: 'var(--ink-secondary)' }}>
              {analytics.insights.map((line, i) => (
                <li key={i} className="flex gap-2">
                  <span style={{ color: 'var(--accent)' }}>•</span>
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}
          </>
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
      {(expectedByFunder.length > 0 || expectedByHolder.length > 0) && (
        <div className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            <span className="icon-badge icon-badge-info shrink-0" style={{ width: '1.75rem', height: '1.75rem' }}>
              <ClockIcon size={13} />
            </span>
            Expected — not yet sold
          </h2>
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            Estimated from the live share price where the IPO's listed and its symbol is on file, or the GMP
            projection otherwise — not a confirmed amount until it's actually marked sold. Funder's share only
            applies when the split isn't turned off for that application.
          </p>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <SettlementPartyList
              title="Expected to send (funder's share)"
              groups={expectedByFunder}
              amountColor="var(--ink-secondary)"
              emptyLabel="Nothing allotted-and-unsold with a funder right now."
              isEstimate
            />
            <SettlementPartyList
              title="Expected to receive (holder's cut)"
              groups={expectedByHolder}
              amountColor="var(--ink-secondary)"
              emptyLabel="Nothing allotted-and-unsold with a holder cut right now."
              isEstimate
            />
          </div>
        </div>
      )}

      {ipoSettlementGroups.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            <span className="icon-badge icon-badge-good shrink-0" style={{ width: '1.75rem', height: '1.75rem' }}>
              <ChecklistIcon size={13} />
            </span>
            Settlement — by IPO
          </h2>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {ipoSettlementGroups.map((g) => (
              <IpoSettlementCard key={g.ipoName} group={g} onLogged={invalidatePayoutsData} />
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
                      {/* First word only, same compact convention Dashboard's
                          own panels use (e.g. PendingMandatePanel) — the full
                          company name is already on screen elsewhere on this
                          page (Settlement — by IPO), this line is meant to
                          be scannable, not a second full listing. */}
                      <span style={{ color: 'var(--ink-muted)' }}>
                        {l.ipoName.split(' ')[0]} · {l.kind === 'cut' ? 'cut' : 'share'} · ₹
                        {Math.round(l.amount).toLocaleString('en-IN')}
                      </span>
                      <span className="flex shrink-0 items-center gap-2.5">
                        {l.phone && (
                          <button
                            onClick={() => sendCustomWhatsapp(l.phone!, payoutMessage(l.row, l.result, l.kind))}
                            aria-label="Message"
                            title="Message"
                            className="link-accent inline-flex items-center"
                          >
                            <PaperAirplaneIcon size={14} />
                          </button>
                        )}
                        {l.paid ? (
                          <span className="badge badge-good">Paid</span>
                        ) : (
                          <button
                            onClick={() => onMarkPaid(l)}
                            disabled={markingPaid === l.applicationId + l.field}
                            aria-label={markingPaid === l.applicationId + l.field ? 'Marking…' : 'Mark paid'}
                            title={markingPaid === l.applicationId + l.field ? 'Marking…' : 'Mark paid'}
                            className="link-accent inline-flex items-center disabled:opacity-50"
                          >
                            <CheckCircleFillIcon size={14} />
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

// KPI-tile hover panels — same HoverCard-via-StatTile pattern DashboardPage
// established (StatTile itself lives there, exported for reuse). Kept local
// to this file rather than imported, same reasoning DashboardPage's own
// small panel components use: each is a few lines, single-consumer.
function SuccessfulIposPanel({ rows }: { rows: IpoBreakdownRow[] }) {
  const successful = rows.filter((r) => r.profit > 0)
  if (successful.length === 0) return <PanelEmpty>No profitable IPOs in this range yet.</PanelEmpty>
  return (
    <div className="space-y-1.5">
      {successful.map((r) => (
        <div key={r.ipoId} className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
            {r.ipoName}
          </span>
          <span className="shrink-0" style={{ color: 'var(--good)' }}>
            {rupees(r.profit)}
          </span>
        </div>
      ))}
    </div>
  )
}

function PendingByAccountPanel({ rows }: { rows: AccountPendingRow[] }) {
  if (rows.length === 0) return <PanelEmpty>Nothing owed right now.</PanelEmpty>
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.funderName} className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
            {r.funderName}
          </span>
          <span className="shrink-0" style={{ color: 'var(--warning)' }}>
            {rupees(r.pending)}
          </span>
        </div>
      ))}
    </div>
  )
}

function PanelEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="p-1" style={{ color: 'var(--ink-muted)' }}>
      {children}
    </p>
  )
}
