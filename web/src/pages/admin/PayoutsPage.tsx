// A dedicated, portal-wide view of every payout obligation from a SOLD
// application — the demat holder's cut, and the funder's 50/50 share when
// applicable — across every IPO at once, not just whichever one happens to
// be selected on the Allotment board. That page's "Sold status & payouts"
// section already does the per-IPO version of this; this page is the
// running ledger: what's still owed, to whom, and (once marked) a paid
// history — so nothing has to be reconstructed by memory or by clicking
// through every settled IPO one at a time.
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { FunderPayoutsPage } from './FunderPayoutsPage'
import {
  ChevronDownIcon,
  SearchIcon,
  ClockIcon,
  ChecklistIcon,
  PaperAirplaneIcon,
  CheckCircleFillIcon,
} from '@primer/octicons-react'
import { supabase } from '../../lib/supabase'
import { showToast } from '../../lib/toast'
import { computeProfitSplit } from '../../lib/profitSplit'
import { sendCustomWhatsapp } from '../../lib/dispatchWhatsapp'
import { payoutMessage } from './AllotmentBoardPage'
import { effectiveSplitWithFunder, payoutCutContact } from '../../lib/profitSplit'
import { maybeAutoArchiveIpo } from '../../lib/autoArchive'
import { usePayoutsData } from '../../lib/usePayoutsData'
import {
  buildUnrealizedProfitLines,
  expectedProfitBreakdown,
  type UnrealizedProfitLine,
  type buildFunderAllottedCards,
} from '../../lib/expectedProfit'
import { settledPaidFlags, SETTLED_EPSILON, type SettlementCard, type IpoSettlementGroup } from '../../lib/settlement'
import type { AllotmentBoardRow, SettlementPaymentKind } from '../../types/database'
import { InlineSpinner, Skeleton } from '../../components/PageSpinner'
import { useCountUp } from '../../lib/useCountUp'
import { buildPayoutAnalytics, resolveDateRange, type DateRangePreset } from '../../lib/payoutAnalytics'

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
const EMPTY_BOARD_ROWS: AllotmentBoardRow[] = []

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

// Net per real person, NOT per application — a person with two applications
// (one still owed +5000, one overpaid -1910) nets to 3090, not 5000 (the old
// per-card Math.max(0, ...) sum lost the second application's credit
// entirely, the exact bug Dashboard's own buildPendingPayouts already fixed
// the same way). Returns everyone with a nonzero net; callers split
// positive (still owed) from negative (overpaid, see the overpayments
// array below) themselves.
function netSettlementByParty(cards: SettlementCard[], side: 'funder' | 'holder'): SettlementPartyGroup[] {
  const byName = new Map<string, SettlementPartyGroup>()
  for (const c of cards) {
    const name = side === 'funder' ? c.funderName : c.holderName
    const phone = side === 'funder' ? c.funderPhone : c.holderPhone
    const remaining = side === 'funder' ? c.remainingToFunder : c.remainingFromHolder
    const applicable = side === 'funder' ? c.hasFunder && !c.isFunderSelf : !c.isDematHolderSelf
    if (!applicable || !name || Math.abs(remaining) <= SETTLED_EPSILON) continue
    if (!byName.has(name)) byName.set(name, { name, phone, total: 0, ipos: [] })
    const g = byName.get(name)!
    if (!g.phone && phone) g.phone = phone
    g.total += remaining
    g.ipos.push({ ipoName: c.ipoName, amount: remaining })
  }
  return Array.from(byName.values())
}

// Same shape as netSettlementByParty, filtered to positive nets only (still
// genuinely owed) — what "You need to send"/"You need to receive" show.
function groupSettlementByParty(cards: SettlementCard[], side: 'funder' | 'holder'): SettlementPartyGroup[] {
  return netSettlementByParty(cards, side)
    .filter((g) => g.total > SETTLED_EPSILON)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

interface FunderCompactLine {
  ipoName: string
  toSend: number
  sent: number
}
interface FunderCompactGroup {
  name: string
  phone: string | null
  lines: FunderCompactLine[]
}

// Every funder with a SOLD application, regardless of settled status — the
// dropdown list under the top summary card, so a fully-paid funder is still
// visible (just shows "Sent" with nothing left to send) instead of only
// ever showing up while still owed money (groupSettlementByParty's own job).
function groupAllFundersCompact(cards: SettlementCard[]): FunderCompactGroup[] {
  const byName = new Map<string, FunderCompactGroup>()
  for (const c of cards) {
    if (!c.hasFunder || c.isFunderSelf || !c.funderName) continue
    if (!byName.has(c.funderName)) byName.set(c.funderName, { name: c.funderName, phone: c.funderPhone, lines: [] })
    const g = byName.get(c.funderName)!
    if (!g.phone && c.funderPhone) g.phone = c.funderPhone
    g.lines.push({ ipoName: c.ipoName, toSend: Math.max(0, c.remainingToFunder), sent: c.amountToFunder - c.remainingToFunder })
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
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
  const {
    isAdmin,
    profile,
    boardQuery,
    rows,
    allRows,
    payments,
    expectedCards,
    livePriceBySymbol,
    case2ManagerIds,
    settlementCards,
    ipoSettlementGroups,
    profitPersonName,
    listingCutoff,
    loading,
    loadError,
    invalidatePayoutsData,
  } = usePayoutsData()
  const [markingPaid, setMarkingPaid] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [openIpoRangeIds, setOpenIpoRangeIds] = useState<Set<string>>(new Set())
  function toggleIpoRangeOpen(ipoId: string) {
    setOpenIpoRangeIds((s) => {
      const next = new Set(s)
      if (next.has(ipoId)) next.delete(ipoId)
      else next.add(ipoId)
      return next
    })
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

  // --- Profit & Payout Analytics dashboard (v1.187.0) ---
  // Default period is This Month -> today, per spec. Everything below is
  // derived from buildPayoutAnalytics (lib/payoutAnalytics.ts), which
  // itself only ever calls INTO existing calculations (computeProfitSplit,
  // buildBookedProfitLines, buildUnrealizedProfitLines, buildSettlementCards)
  // rather than a second profit formula living in this file.
  const [rangePreset, setRangePreset] = useState<DateRangePreset>('this_month')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const todayIstStr = listingCutoff.todayIstStr
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
    () =>
      buildPayoutAnalytics(
        allRows,
        boardQuery.data ?? EMPTY_BOARD_ROWS,
        payments,
        range,
        profitPersonName,
        case2ManagerIds,
        livePriceBySymbol,
        listingCutoff,
      ),
    [allRows, boardQuery.data, payments, range, profitPersonName, case2ManagerIds, livePriceBySymbol, listingCutoff],
  )
  // Counts up from 0 on mount/change instead of snapping straight to the
  // number — useCountUp itself no-ops (renders the real value immediately)
  // while analytics is still the empty-array default, so there's nothing to
  // animate FROM until real data exists — the loading skeleton below covers
  // that gap instead.
  const animatedTotalProfit = useCountUp(analytics.summary.totalProfit)

  // A funder-only viewer gets the same detail page an admin drills into
  // from the Funders list below — v_allotment_board/the ALLOTTED-with-embeds
  // query are already RLS-scoped to just their own data, so rendering it
  // here with no funderName param naturally shows just their own numbers.
  if (!isAdmin) return <FunderPayoutsPage />

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
  // Netted PER PERSON first (netSettlementByParty), not per application —
  // summing Math.max(0, ...) per card lost a person's own overpaid
  // application entirely instead of it reducing what they're still owed.
  const funderNets = netSettlementByParty(settlementCards, 'funder')
  const holderNets = netSettlementByParty(settlementCards, 'holder')
  const totalStillFromHolder = holderNets.reduce((s, g) => s + Math.max(0, g.total), 0)
  const totalStillToFunder = funderNets.reduce((s, g) => s + Math.max(0, g.total), 0)
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
      listingCutoff,
    ),
  )
  // Same figure Dashboard's own "Expected profit" tile shows (ALLOTTED,
  // not-yet-sold applications only — never blended with realized/booked
  // profit, which settlementCards/totalMyProfit above already covers) — now
  // surfaced here too so this page's own top summary card doesn't make you
  // go to Dashboard to see it. expectedCards already has the listing-cutoff
  // filter applied (see the queryFn above), so this and expectedByFunder
  // never disagree.
  const totalExpectedProfit = expectedCards.reduce(
    (sum, c) => sum + expectedProfitBreakdown(c, c.symbol ? livePriceBySymbol[c.symbol] : null).netYourProfit,
    0,
  )
  // Real overpayment events — a person whose NET remaining (across all
  // their applications) is negative, meaning they're owed money back. Built
  // from the same funderNets/holderNets above so this never disagrees with
  // totalStillToFunder/totalStillFromHolder on what's actually netted.
  interface OverpaymentRow {
    key: string
    name: string
    ipoName: string
    amount: number
    direction: 'to funder' | 'from holder'
  }
  // Every funder, dropdown per name — compact per-IPO send/sent status,
  // below the top summary card.
  const funderCompactGroups = groupAllFundersCompact(settlementCards)
  const mostOverpaidIpo = (g: SettlementPartyGroup) => g.ipos.reduce((min, l) => (l.amount < min.amount ? l : min), g.ipos[0])
  const overpayments: OverpaymentRow[] = []
  for (const g of funderNets) {
    if (g.total >= -SETTLED_EPSILON) continue
    overpayments.push({ key: `${g.name}-funder`, name: g.name, ipoName: mostOverpaidIpo(g).ipoName, amount: -g.total, direction: 'to funder' })
  }
  for (const g of holderNets) {
    if (g.total >= -SETTLED_EPSILON) continue
    overpayments.push({ key: `${g.name}-holder`, name: g.name, ipoName: mostOverpaidIpo(g).ipoName, amount: -g.total, direction: 'from holder' })
  }

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
        {(settlementCards.length > 0 || expectedCards.length > 0) && (
          // grid grid-cols-2, not flex+shrink-0 — the old flex layout's
          // shrink-0 kept the card at its full unwrapped content width no
          // matter how narrow the viewport got (shrink-0 blocks the very
          // shrinking flex-wrap needs to ever trigger), which silently ran
          // the 4th figure (added here) off the right edge of the screen on
          // mobile instead of wrapping it onto a second row. w-full sm:w-auto
          // lets the card take the full row on mobile — same fix pattern as
          // UsersPage's own mobile-overflow fix.
          <div className="card grid w-full grid-cols-2 gap-x-4 gap-y-3 px-4 py-2.5 text-sm sm:flex sm:w-auto sm:items-center">
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
            {/* Projected only (ALLOTTED, not yet sold) — never blended into
                My profit above, which is real/confirmed money from already-
                SOLD applications. See totalExpectedProfit's own comment. */}
            <div>
              <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                Expected profit
              </p>
              <p className="font-mono-ipo font-semibold" style={{ color: 'var(--accent)' }}>
                {rupees(totalExpectedProfit)}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Real overpayment events — the top summary card's totals clamp a
          negative remainder to 0 per party (can't net one funder's credit
          against a different funder's balance in one combined number), so
          this is the one place that actually shows "you're owed this back."
          Same "−₹X (overpaid)" figure/wording each IPO's own settlement
          card already uses for this exact state — see settlement.ts's
          SettlementCard (remainingToFunder/remainingFromHolder can go
          negative on purpose, never clamped there). Only rendered when
          there's actually one to show. */}
      {overpayments.length > 0 && (
        <div className="card space-y-1.5 p-4 text-sm">
          <p className="text-xs font-medium tracking-wide uppercase" style={{ color: 'var(--ink-muted)' }}>
            Overpaid
          </p>
          {overpayments.map((o) => (
            <div key={o.key} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate" style={{ color: 'var(--ink-primary)' }}>
                {o.name} - {o.ipoName.split(' ')[0]}
              </span>
              <span className="shrink-0 font-mono-ipo font-semibold" style={{ color: 'var(--warning-text)' }}>
                −{rupees(o.amount)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Every funder — click through to their own detail page (every
          allotted IPO, money transactions, an overall summary) instead of
          an inline dropdown here. */}
      {funderCompactGroups.length > 0 && (
        <div className="card divide-y p-0 text-sm" style={{ borderColor: 'var(--border)' }}>
          {funderCompactGroups.map((g) => {
            const totalToSend = g.lines.reduce((s, l) => s + l.toSend, 0)
            return (
              <Link
                key={g.name}
                to={`/payouts/funder/${encodeURIComponent(g.name)}`}
                className="flex w-full items-center justify-between gap-2 p-3 transition-colors hover:bg-[var(--hover-surface)]"
              >
                <span className="truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
                  {g.name}
                </span>
                <span className="shrink-0 text-xs" style={{ color: totalToSend > SETTLED_EPSILON ? 'var(--critical-text)' : 'var(--good)' }}>
                  {totalToSend > SETTLED_EPSILON ? `Send ${rupees(totalToSend)}` : 'Fully paid'}
                </span>
              </Link>
            )
          })}
        </div>
      )}

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
        {/* Total profit only — per feedback, everything else (KPI grid,
            realized/unrealized split, payout status, full IPO/account
            tables, capital utilization, insights) dropped from this
            range-filtered view. Those numbers still exist in
            lib/payoutAnalytics.ts if a future ask brings them back. */}
        <div className="card p-5">
          <p className="text-xs font-medium tracking-wide uppercase" style={{ color: 'var(--ink-muted)' }}>
            {range.label} · Total profit
          </p>
          <div className="mt-1 flex flex-wrap items-baseline gap-3">
            <p className="font-mono-ipo text-4xl font-bold" style={{ color: 'var(--good)' }}>
              {rupees(animatedTotalProfit)}
            </p>
            <span className="badge badge-good">{analytics.summary.roi.toFixed(2)}% ROI</span>
          </div>
        </div>

        {/* Applied/allotted per IPO, with which account and funder — a
            compact substitute for the old full IPO-wise/account-wise
            tables. Allotted IPOs get a highlighted card (money's actually
            moved); names sit behind a dropdown instead of always shown. */}
        {analytics.ipoAccountBreakdown.length > 0 && (
          <div className="space-y-2">
            {analytics.ipoAccountBreakdown.map((r) => {
              const isAllotted = r.allotted > 0
              const profit = analytics.ipoBreakdown.find((b) => b.ipoId === r.ipoId)?.profit ?? 0
              const open = openIpoRangeIds.has(r.ipoId)
              return (
                <div
                  key={r.ipoId}
                  className="card p-3"
                  style={isAllotted ? { borderColor: 'var(--good)', background: 'var(--hover-surface)' } : undefined}
                >
                  <button
                    type="button"
                    onClick={() => toggleIpoRangeOpen(r.ipoId)}
                    className="flex w-full items-center justify-between gap-2"
                  >
                    <span className="min-w-0 truncate text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {r.ipoName.split(' ')[0]}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs">
                      <span style={{ color: 'var(--ink-muted)' }}>
                        {r.allotted}/{r.applied} allotted
                      </span>
                      {isAllotted && (
                        <span className="font-mono-ipo font-semibold" style={{ color: profit >= 0 ? 'var(--good)' : 'var(--critical)' }}>
                          {rupees(profit)}
                        </span>
                      )}
                      <span style={{ display: 'inline-flex', transform: open ? 'rotate(180deg)' : undefined }}>
                        <ChevronDownIcon size={14} fill="var(--ink-muted)" />
                      </span>
                    </span>
                  </button>
                  {open && (
                    <div className="mt-2 space-y-0.5 border-t pt-2" style={{ borderColor: 'var(--border)' }}>
                      {r.accounts.map((a, i) => (
                        <p key={i} className="truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                          {a.holderName}
                          {a.funderName && a.funderName !== a.holderName && ` · via ${a.funderName}`}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {/* Best / worst — one card, not two */}
        {(analytics.best || analytics.worst) && (
          <div className="card grid grid-cols-1 divide-y p-4 sm:grid-cols-2 sm:divide-x sm:divide-y-0" style={{ borderColor: 'var(--border)' }}>
            {analytics.best && (
              <div className="py-2 sm:py-0 sm:pr-4">
                <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>🏆 Best performing</p>
                <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>{analytics.best.ipoName}</p>
                <p className="font-mono-ipo text-sm" style={{ color: 'var(--good)' }}>
                  {rupees(analytics.best.profit)} · {analytics.best.roi.toFixed(1)}% ROI
                </p>
              </div>
            )}
            {analytics.worst && (
              <div className="py-2 sm:py-0 sm:pl-4">
                <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>Lowest performing</p>
                <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>{analytics.worst.ipoName}</p>
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
export function IpoSettlementCard({
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
  // One key per log-payment ATTEMPT, not per network request — generated
  // once when the form opens, reused across any retry of that same
  // attempt (a timed-out request that actually succeeded, a second click
  // after a transient error), and only cleared once a payment actually
  // lands. A ref, not state: changing it must never itself trigger a
  // re-render. See migration 0084 — the unique index this keys against is
  // the actual fix; this is just where the key comes from.
  const idempotencyKeyRef = useRef<string | null>(null)

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
    // Same key for every retry of this one attempt — only minted fresh when
    // the form is opened (see the "+ Log a payment" button below), so a
    // second click here after a timeout/error reuses it rather than making
    // a new one, which is what actually makes the 23505 branch below mean
    // "this exact attempt already landed" instead of "coincidence."
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = crypto.randomUUID()
    const idempotencyKey = idempotencyKeyRef.current

    // What this payment leaves outstanding, computed BEFORE the write —
    // mirrors buildSettlementCards' own two reducers: a holder_to_funder
    // payment counts against BOTH sides at once (it left the holder and
    // reached the funder, it just never passed through the admin), which is
    // why these aren't exclusive. Only the resulting true/false flags cross
    // into SQL below — the split itself (amountFromHolder/amountToFunder)
    // still only ever exists in computeProfitSplit on the client; see
    // settlement.ts's own note on why that math doesn't get reimplemented
    // in the database.
    const nextFromHolder =
      c.remainingFromHolder - (kind === 'holder_to_admin' || kind === 'holder_to_funder' ? amt : 0)
    const nextToFunder =
      c.remainingToFunder - (kind === 'admin_to_funder' || kind === 'holder_to_funder' ? amt : 0)
    const flags = settledPaidFlags(c, nextFromHolder, nextToFunder)

    setSaving(true)
    // Both the payment insert and the paid-flag update happen inside ONE
    // Postgres transaction (migration 0087) — either both land or neither
    // does, instead of the old two-sequential-calls version where a second-
    // call failure could leave a real, saved payment with stale flags next
    // to it.
    const { error } = await supabase.rpc('log_settlement_payment', {
      p_application_id: c.applicationId,
      p_kind: kind,
      p_amount: amt,
      p_note: note.trim() || null,
      p_idempotency_key: idempotencyKey,
      p_set_demat_cut_paid: !!flags.demat_cut_paid,
      p_set_funder_share_paid: !!flags.funder_share_paid,
    })
    if (error && error.code !== '23505') {
      setSaving(false)
      showToast(error.message, 'critical')
      return
    }
    if (error) {
      // 23505 on idempotency_key means THIS exact attempt already landed —
      // most likely the previous click's request actually succeeded (flags
      // included) and the "Logging…" state just never heard back before the
      // admin retried. Not a failure: the payment and its flags are already
      // saved, same as if this call had returned success the first time.
      showToast('Already logged — this payment was saved on an earlier attempt.', 'info')
    } else if (Object.keys(flags).length > 0) {
      // Settling the last side of the last unsettled row can be what makes
      // the whole IPO archivable, same check the Allotment board runs after
      // its own "Mark paid". Only run on a genuine fresh success — a 23505
      // retry means this already ran on the original attempt.
      await maybeAutoArchiveIpo(c.ipoId)
    }

    // Cleared only on confirmed success (real or "already logged") — the
    // next time this form opens, it's a genuinely new payment and needs a
    // fresh key, not the previous one.
    idempotencyKeyRef.current = null
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
              <button
                onClick={() => {
                  idempotencyKeyRef.current = null
                  setShowLog(false)
                }}
                className="btn-secondary text-xs"
              >
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
