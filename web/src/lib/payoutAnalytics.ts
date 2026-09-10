// Orchestration for the Payouts analytics dashboard — every number here is
// assembled from calculations that already exist elsewhere in this app
// (computeProfitSplit, buildBookedProfitLines, buildUnrealizedProfitLines,
// buildSettlementCards) rather than a second, parallel profit formula. This
// file's own job is narrow: pick which rows fall in the selected date
// range, and fold the existing per-application lines into the shapes a
// dashboard needs (KPIs, a trend series, IPO/account breakdowns).
//
// WHICH MONTH a row belongs to is decided in ONE place — payoutClassificationDate
// (lib/payoutDate.ts): the allotment date for an open position, the sale
// date for a realized one, never applied_at (an IPO's application window
// routinely straddles a month boundary). Every payout figure below —
// profit, the invested amount behind it, the per-IPO/per-account/capital
// breakdown, allotment & sale counts — is bucketed by that and only that,
// so one application is attributed to exactly one month. applied_at is used
// for one thing only: the "applications submitted" activity count.
//
// Authoritative sources, so every figure here is traceable:
//   Investment       = the investedAmount of the realized + unrealized
//                       profit lines in range (each derived from
//                       applications.bid_amount; prorated per tranche for a
//                       partial sell) — so ROI is always profit / this
//   Allotted shares   = applications.lots x ipos.lot_size, for ALLOTTED/PARTIALLY_SOLD/SOLD rows
//   Realized profit   = buildBookedProfitLines (SOLD rows, applications.sell_price)
//   Unrealized profit = buildUnrealizedProfitLines (ALLOTTED rows, live price
//                       if the IPO's listed and its symbol is on file,
//                       GMP-based estimate otherwise — NEVER shown blended
//                       with realized profit as one undifferentiated number)
//   Payout paid       = settlement_payments.amount (a real logged transfer,
//                       migration 0078 — there is no separate "payout status"
//                       column; every row IS a confirmed payment)
//   Payout pending    = buildSettlementCards' remainingToFunder (this app's
//                       existing, only settlement calculation — see
//                       lib/settlement.ts)
//
// Explicitly NOT modeled, because nothing in this schema tracks it (adding
// these would mean inventing numbers, which the brief this was built against
// explicitly forbids):
//   - Payout method / transaction reference ID (settlement_payments has no
//     such columns)
//   - "Failed" / "Processing" payout states (a settlement_payments row is
//     only ever created after money has already moved — there is no
//     in-flight state to represent)
//   - Listing gain vs. selling gain as separate categories (one sell_price
//     is recorded per application, whenever it's actually marked sold —
//     this schema does not separately track a listing-day price)
//   - "Total available capital" (no capital pool/ceiling exists anywhere in
//     this data model, only per-application bid amounts)
import { parseGmpPercent } from './ipoGmp'
import {
  buildBookedProfitLines,
  buildUnrealizedProfitLines,
  effectiveFunder,
  type ProfitProjectionRow,
  type BookedProfitLine,
  type UnrealizedProfitLine,
  type ListingCutoff,
} from './expectedProfit'
import { buildSettlementCards } from './settlement'
import { rowSellSplit } from './partialSells'
import { payoutClassificationDate, isAllotmentStatus } from './payoutDate'
import { istDateOf } from './ipoStatus'
import type { AllotmentBoardRow, SettlementPayment } from '../types/database'

export type DateRangePreset = 'this_month' | 'last_month' | 'last_3_months' | 'this_year' | 'all_time' | 'custom'

export interface DateRange {
  preset: DateRangePreset
  start: string // yyyy-mm-dd, inclusive
  end: string // yyyy-mm-dd, inclusive
  label: string
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// All boundaries computed off IST wall-clock date (nowIstStr), not the
// browser's local timezone — same reasoning nowIst() itself documents
// elsewhere in this app: a plain new Date() reads UTC, which is still
// "yesterday" for the first 5.5 hours of every IST day.
export function resolveDateRange(preset: DateRangePreset, todayIstStr: string, custom?: { start: string; end: string }): DateRange {
  const [y, m] = todayIstStr.split('-').map(Number)
  const monthLabel = (year: number, month: number) =>
    new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })

  switch (preset) {
    case 'this_month': {
      const start = `${y}-${String(m).padStart(2, '0')}-01`
      return { preset, start, end: todayIstStr, label: monthLabel(y, m) }
    }
    case 'last_month': {
      const lm = m === 1 ? 12 : m - 1
      const ly = m === 1 ? y - 1 : y
      const start = `${ly}-${String(lm).padStart(2, '0')}-01`
      const end = ymd(new Date(Date.UTC(ly, lm, 0))) // last day of that month
      return { preset, start, end, label: monthLabel(ly, lm) }
    }
    case 'last_3_months': {
      const startDate = new Date(Date.UTC(y, m - 1, 1))
      startDate.setUTCMonth(startDate.getUTCMonth() - 2)
      return { preset, start: ymd(startDate), end: todayIstStr, label: 'Last 3 months' }
    }
    case 'this_year':
      return { preset, start: `${y}-01-01`, end: todayIstStr, label: `${y}` }
    case 'all_time':
      return { preset, start: '2000-01-01', end: todayIstStr, label: 'All time' }
    case 'custom':
      return { preset, start: custom?.start ?? todayIstStr, end: custom?.end ?? todayIstStr, label: 'Custom range' }
  }
}

// range.start / range.end are IST calendar dates (resolveDateRange builds
// them off an IST "today"), so the value being tested is normalised to its
// IST calendar date too — a bare yyyy-mm-dd passes straight through, a
// timestamptz is shifted +5:30 before its date is read. Without this an
// event just after IST midnight (e.g. a sale logged at 01:00 IST on the 1st,
// stored as 19:30Z on the last of the previous month) fell into the wrong
// month.
function inRange(dateIso: string | null | undefined, range: DateRange): boolean {
  if (!dateIso) return false
  const d = istDateOf(dateIso)
  return d >= range.start && d <= range.end
}

export interface MonthlySummary {
  // Realized + unrealized combined — the "combined" total the KPI card
  // shows, with realizedProfit/unrealizedProfit alongside it so the two are
  // never presented as one undifferentiated number.
  totalProfit: number
  realizedProfit: number
  unrealizedProfit: number
  totalInvested: number
  totalPayout: number
  pendingPayout: number
  roi: number
  successfulIpoCount: number
  totalApplications: number
  totalSharesAllotted: number
}

export interface IpoBreakdownRow {
  ipoId: string
  ipoName: string
  investment: number
  allottedShares: number
  exitValue: number // 0 until sold
  profit: number
  isRealized: boolean
  roi: number
  payoutStatus: 'Paid' | 'Pending' | 'Partial' | 'N/A'
}

export interface AccountBreakdownRow {
  funderName: string
  investment: number
  profit: number
  roi: number
  successfulIpos: number
  payout: number
}

export interface TrendPoint {
  date: string
  dailyProfit: number
  cumulativeProfit: number
  dailyInvestment: number
  cumulativeInvestment: number
  dailyPayout: number
  cumulativePayout: number
}

export interface PayoutStatusBreakdown {
  paid: number
  pending: number
}

export interface CapitalUtilization {
  invested: number // bid_amount across every non-cancelled application in range
  locked: number // bid_amount still held (ALLOTTED, not yet sold)
  released: number // bid_amount returned (SOLD)
}

export interface BestWorstIpo {
  ipoName: string
  profit: number
  roi: number
}

// Application counts by status within range — backs the "Applications" KPI
// tile's hover panel. applied / notAllotted are counted by submission date
// (applicationsInRange); allotted / partiallySold / sold by the money-event
// date (payoutRowsInRange) — see buildPayoutAnalytics. Not re-derived from
// ipoBreakdown, which only covers rows that produced a profit line.
export interface ApplicationStatusCounts {
  applied: number
  allotted: number
  notAllotted: number
  partiallySold: number
  sold: number
}

// Per-IPO share count — backs the "Shares allotted" KPI tile's hover panel.
export interface IpoShareRow {
  ipoName: string
  shares: number
}

// Per-account amount still owed out to a funder — backs the "Pending
// payout" KPI tile's hover panel. Same settlementCards remainingToFunder
// this page's own settlement UI reads, just grouped by funder name.
export interface AccountPendingRow {
  funderName: string
  pending: number
}

export interface PayoutAnalytics {
  range: DateRange
  summary: MonthlySummary
  ipoBreakdown: IpoBreakdownRow[]
  accountBreakdown: AccountBreakdownRow[]
  statusBreakdown: ApplicationStatusCounts
  sharesByIpo: IpoShareRow[]
  pendingByAccount: AccountPendingRow[]
  trend: TrendPoint[]
  payoutStatus: PayoutStatusBreakdown
  capital: CapitalUtilization
  best: BestWorstIpo | null
  worst: BestWorstIpo | null
  insights: string[]
  // Raw lines, for the transaction-history table below the analytics —
  // avoids a second pass over the same rows just to re-derive them.
  realizedLines: BookedProfitLine[]
  unrealizedLines: UnrealizedProfitLine[]
  ipoAccountBreakdown: IpoAccountRow[]
}

// Compact "which account, funded by whom" view, one row per IPO that had an
// allotment or sale in the selected month. `allotted` is how many of that
// IPO's applications got a money event in the month; `applied` is the IPO's
// total non-cancelled application count (whole cycle — a short IPO belongs
// entirely to its allotment month). `accounts` is the distinct (holder,
// funder) pairs behind the allotted rows.
export interface IpoAccountRow {
  ipoId: string
  ipoName: string
  applied: number
  allotted: number
  accounts: { holderName: string; funderName: string | null }[]
}

export function buildPayoutAnalytics(
  allRows: ProfitProjectionRow[],
  boardRows: AllotmentBoardRow[],
  payments: SettlementPayment[],
  range: DateRange,
  profitPersonName: string,
  case2ManagerIds: Set<string>,
  livePriceBySymbol: Record<string, number | null>,
  // Optional — only PayoutsPage passes this (see lib/expectedProfit.ts's
  // ListingCutoff). Held back for a still-ALLOTTED row whose IPO lists
  // today, before 10am IST — the first hour of trading can still be NSE's
  // pre-open indicative price, not a real one.
  listingCutoff?: ListingCutoff,
): PayoutAnalytics {
  // TWO scopes, one date rule (lib/payoutDate.ts):
  //
  //  • applicationsInRange — every non-cancelled application whose bid was
  //    SUBMITTED in the period (applied_at). This is an activity figure:
  //    "how many applications did I put in, how much did I commit" — it is
  //    NOT a payout figure and never drives profit, capital, or the
  //    per-IPO/per-account breakdown. Kept only for the "applications
  //    submitted" count.
  //
  //  • payoutRowsInRange — rows with a real money event (allotment or sale)
  //    whose payoutClassificationDate falls in the period. THIS is what
  //    every payout figure below is built from. An application's whole
  //    lifecycle is attributed to exactly one month — the month of its most
  //    recent money event — so an IPO whose application window straddled a
  //    month boundary (ESDS opened 28 Aug, allotted 2 Sep) can never show up
  //    in both This month and Last month.
  const applicationsInRange = allRows.filter(
    (r) => inRange(r.applied_at, range) && r.mandate_status !== 'CANCELLED',
  )
  const payoutRowsInRange = allRows.filter(
    (r) =>
      isAllotmentStatus(r.status) &&
      r.mandate_status !== 'CANCELLED' &&
      inRange(payoutClassificationDate(r), range),
  )

  const realizedLines = buildBookedProfitLines(allRows, profitPersonName, case2ManagerIds).filter((l) =>
    inRange(l.realizedAt, range),
  )
  const unrealizedLines = buildUnrealizedProfitLines(
    allRows,
    profitPersonName,
    livePriceBySymbol,
    case2ManagerIds,
    listingCutoff,
  ).filter((l) => inRange(l.allottedAt, range))

  const realizedProfit = realizedLines.reduce((s, l) => s + l.profit, 0)
  const unrealizedProfit = unrealizedLines.reduce((s, l) => s + l.profit, 0)
  // The capital actually behind the profit in this period — summed from the
  // very same realized + unrealized lines, so ROI (totalProfit / this) is
  // always self-consistent and a PARTIALLY_SOLD row contributes only its
  // prorated slice on each side rather than its whole bid twice. (The old
  // definition summed bid_amount over applied_at-in-range rows, a different
  // set of applications from the ones the profit came from.)
  const totalInvested =
    realizedLines.reduce((s, l) => s + (l.investedAmount ?? 0), 0) +
    unrealizedLines.reduce((s, l) => s + l.investedAmount, 0)

  const paymentsInRange = payments.filter((p) => inRange(p.created_at, range))
  const totalPayout = paymentsInRange.reduce((s, p) => s + p.amount, 0)

  // Settlement cards drive pendingPayout — reuses this app's ONE settlement
  // calculation (lib/settlement.ts) rather than re-deriving "what's still
  // owed" a second way. Scoped to SOLD rows realized within range, same set
  // realizedLines covers, so pendingPayout and realizedProfit are talking
  // about the same underlying applications.
  const soldIdsInRange = new Set(realizedLines.map((l) => l.applicationId).filter((id): id is string => !!id))
  const paymentsByApp = new Map<string, SettlementPayment[]>()
  for (const p of payments) {
    if (!paymentsByApp.has(p.application_id)) paymentsByApp.set(p.application_id, [])
    paymentsByApp.get(p.application_id)!.push(p)
  }
  const settlementCards = buildSettlementCards(
    boardRows.filter((r) => soldIdsInRange.has(r.application_id)),
    profitPersonName,
    paymentsByApp,
  )
  // Netted PER FUNDER before clamping, not per application. Summing
  // Math.max(0, ...) per card discards an overpaid application's credit
  // instead of letting it reduce what that same person is still owed, which
  // overstates what's actually pending (Avinash: −1,910 on one application
  // and +3,667 on another is a real balance of 1,757, not 3,667). Same rule
  // PayoutsPage's own netSettlementByParty applies.
  const pendingByFunderMap = new Map<string, number>()
  for (const c of settlementCards) {
    if (!c.hasFunder || c.isFunderSelf || !c.funderName) continue
    pendingByFunderMap.set(c.funderName, (pendingByFunderMap.get(c.funderName) ?? 0) + c.remainingToFunder)
  }
  const pendingPayout = Array.from(pendingByFunderMap.values()).reduce((s, net) => s + Math.max(0, net), 0)

  const pendingByAccountMap = new Map<string, number>()
  for (const c of settlementCards) {
    if (!c.funderName || c.remainingToFunder <= SETTLED_EPSILON_LOCAL) continue
    pendingByAccountMap.set(c.funderName, (pendingByAccountMap.get(c.funderName) ?? 0) + c.remainingToFunder)
  }
  const pendingByAccount: AccountPendingRow[] = Array.from(pendingByAccountMap.entries())
    .map(([funderName, pending]) => ({ funderName, pending }))
    .sort((a, b) => b.pending - a.pending)

  const totalProfit = realizedProfit + unrealizedProfit
  const roi = totalInvested > 0 ? (totalProfit / totalInvested) * 100 : 0

  // Every allotment-status row attributed to this period (isAllotmentStatus
  // + payoutClassificationDate in range — see payoutRowsInRange). Drives
  // every "shares allotted" / capital / per-IPO figure below.
  const allottedOrSold = payoutRowsInRange
  const totalSharesAllotted = allottedOrSold.reduce((s, r) => s + r.lots * (r.ipos?.lot_size ?? 0), 0)

  // applied / notAllotted are activity counts (applicationsInRange, by
  // applied_at). allotted / partiallySold / sold are payout counts
  // (payoutRowsInRange, by the money-event date) — an application applied
  // for last month but allotted this month is counted as an allotment THIS
  // month and nowhere last month.
  const statusBreakdown: ApplicationStatusCounts = {
    applied: applicationsInRange.filter((r) => r.status === 'APPLIED').length,
    allotted: payoutRowsInRange.filter((r) => r.status === 'ALLOTTED').length,
    notAllotted: applicationsInRange.filter((r) => r.status === 'NOT_ALLOTTED').length,
    partiallySold: payoutRowsInRange.filter((r) => r.status === 'PARTIALLY_SOLD').length,
    sold: payoutRowsInRange.filter((r) => r.status === 'SOLD').length,
  }

  // Total non-cancelled applications per IPO across the whole data set — the
  // "/ N" denominator on each IPO card. Once an IPO is attributed to a month
  // (it had >=1 allotment/sale that month) its full applied count is shown,
  // not a range-sliced one, since the whole short IPO cycle now belongs to
  // that one month.
  const appliedCountByIpo = new Map<string, number>()
  for (const r of allRows) {
    if (r.mandate_status === 'CANCELLED') continue
    appliedCountByIpo.set(r.ipo_id, (appliedCountByIpo.get(r.ipo_id) ?? 0) + 1)
  }
  const ipoAccountMap = new Map<string, IpoAccountRow>()
  for (const r of payoutRowsInRange) {
    if (!r.ipos) continue
    if (!ipoAccountMap.has(r.ipo_id)) {
      ipoAccountMap.set(r.ipo_id, {
        ipoId: r.ipo_id,
        ipoName: r.ipos.company_name,
        applied: appliedCountByIpo.get(r.ipo_id) ?? 0,
        allotted: 0,
        accounts: [],
      })
    }
    const row = ipoAccountMap.get(r.ipo_id)!
    row.allotted += 1
    const holderName = r.demat_accounts?.holder_name ?? 'Unknown'
    const funderName = effectiveFunder(r)?.account_holder_name ?? null
    if (!row.accounts.some((a) => a.holderName === holderName && a.funderName === funderName)) {
      row.accounts.push({ holderName, funderName })
    }
  }
  const ipoAccountBreakdown = Array.from(ipoAccountMap.values()).sort((a, b) => a.ipoName.localeCompare(b.ipoName))

  const sharesByIpoMap = new Map<string, number>()
  for (const r of allottedOrSold) {
    const name = r.ipos?.company_name ?? 'Unknown IPO'
    sharesByIpoMap.set(name, (sharesByIpoMap.get(name) ?? 0) + r.lots * (r.ipos?.lot_size ?? 0))
  }
  const sharesByIpo: IpoShareRow[] = Array.from(sharesByIpoMap.entries())
    .map(([ipoName, shares]) => ({ ipoName, shares }))
    .sort((a, b) => b.shares - a.shares)

  // "Successful IPOs" = distinct IPOs with positive profit, realized or
  // projected — an IPO counts once even if it has several applications.
  const profitByIpo = new Map<string, { ipoName: string; profit: number; investment: number }>()
  for (const l of realizedLines) {
    const e = profitByIpo.get(l.ipoId) ?? { ipoName: l.ipoName, profit: 0, investment: 0 }
    e.profit += l.profit
    e.investment += l.investedAmount ?? 0
    profitByIpo.set(l.ipoId, e)
  }
  for (const l of unrealizedLines) {
    const e = profitByIpo.get(l.ipoId) ?? { ipoName: l.ipoName, profit: 0, investment: 0 }
    e.profit += l.profit
    e.investment += l.investedAmount
    profitByIpo.set(l.ipoId, e)
  }
  const successfulIpoCount = Array.from(profitByIpo.values()).filter((e) => e.profit > 0).length

  const summary: MonthlySummary = {
    totalProfit,
    realizedProfit,
    unrealizedProfit,
    totalInvested,
    totalPayout,
    pendingPayout,
    roi,
    successfulIpoCount,
    totalApplications: applicationsInRange.length,
    totalSharesAllotted,
  }

  // --- IPO-wise breakdown ---
  // Keyed by the same money-event date as everything else (was
  // status_changed_at, which drifts from the real sale date once a row is
  // sold via tranches then a final exit).
  const exitValueByIpo = new Map<string, number>()
  for (const r of allRows) {
    if (!r.ipos || !inRange(payoutClassificationDate(r), range)) continue
    if (r.status === 'SOLD' && r.sell_price != null) {
      exitValueByIpo.set(r.ipo_id, (exitValueByIpo.get(r.ipo_id) ?? 0) + r.sell_price * r.ipos.lot_size * r.lots)
    } else if (r.status === 'PARTIALLY_SOLD') {
      // Real cash already taken out on the sold tranches.
      exitValueByIpo.set(r.ipo_id, (exitValueByIpo.get(r.ipo_id) ?? 0) + rowSellSplit(r).realizedProceeds)
    }
  }
  const paidByIpo = new Map<string, number>()
  for (const c of settlementCards) {
    // amountToFunder − remaining (raw), NOT − Math.max(0, remaining):
    // "paid" is what actually left, and on an overpaid application that is
    // MORE than was owed. Clamping made an overpayment report as if exactly
    // the owed amount had been paid, hiding the excess.
    paidByIpo.set(c.ipoId, (paidByIpo.get(c.ipoId) ?? 0) + (c.amountToFunder - c.remainingToFunder))
  }
  const owedByIpo = new Map<string, number>()
  for (const c of settlementCards) owedByIpo.set(c.ipoId, (owedByIpo.get(c.ipoId) ?? 0) + c.amountToFunder)

  const ipoIds = new Set([...realizedLines.map((l) => l.ipoId), ...unrealizedLines.map((l) => l.ipoId)])
  const ipoBreakdown: IpoBreakdownRow[] = Array.from(ipoIds).map((ipoId) => {
    const realized = realizedLines.filter((l) => l.ipoId === ipoId)
    const unrealized = unrealizedLines.filter((l) => l.ipoId === ipoId)
    const isRealized = realized.length > 0
    const investment =
      realized.reduce((s, l) => s + (l.investedAmount ?? 0), 0) + unrealized.reduce((s, l) => s + l.investedAmount, 0)
    const profit = realized.reduce((s, l) => s + l.profit, 0) + unrealized.reduce((s, l) => s + l.profit, 0)
    const allottedShares =
      realized.reduce((s, l) => s + (l.lots ?? 0), 0) + unrealized.reduce((s, l) => s + l.lots, 0)
    const owed = owedByIpo.get(ipoId) ?? 0
    const paid = paidByIpo.get(ipoId) ?? 0
    const payoutStatus: IpoBreakdownRow['payoutStatus'] = !isRealized
      ? 'N/A'
      : owed <= SETTLED_EPSILON_LOCAL
        ? 'Paid'
        : paid > SETTLED_EPSILON_LOCAL
          ? 'Partial'
          : 'Pending'
    return {
      ipoId,
      ipoName: (realized[0] ?? unrealized[0]).ipoName,
      investment,
      allottedShares,
      exitValue: exitValueByIpo.get(ipoId) ?? 0,
      profit,
      isRealized,
      roi: investment > 0 ? (profit / investment) * 100 : 0,
      payoutStatus,
    }
  })

  // --- Account-wise (funder) breakdown ---
  const byFunder = new Map<string, { investment: number; profit: number; ipoIds: Set<string>; payout: number }>()
  const addFunderLine = (funderName: string, ipoId: string, investment: number, profit: number) => {
    const e = byFunder.get(funderName) ?? { investment: 0, profit: 0, ipoIds: new Set<string>(), payout: 0 }
    e.investment += investment
    e.profit += profit
    if (profit > 0) e.ipoIds.add(ipoId)
    byFunder.set(funderName, e)
  }
  for (const l of realizedLines) addFunderLine(l.funderName, l.ipoId, l.investedAmount ?? 0, l.profit)
  for (const l of unrealizedLines) addFunderLine(l.funderName, l.ipoId, l.investedAmount, l.profit)
  for (const c of settlementCards) {
    if (!c.funderName) continue
    const e = byFunder.get(c.funderName)
    // Raw remaining — same reasoning as paidByIpo above: this is money that
    // actually moved, so an overpayment must count at its real size.
    if (e) e.payout += c.amountToFunder - c.remainingToFunder
  }
  const accountBreakdown: AccountBreakdownRow[] = Array.from(byFunder.entries())
    .map(([funderName, e]) => ({
      funderName,
      investment: e.investment,
      profit: e.profit,
      roi: e.investment > 0 ? (e.profit / e.investment) * 100 : 0,
      successfulIpos: e.ipoIds.size,
      payout: e.payout,
    }))
    .sort((a, b) => b.profit - a.profit)

  // --- Trend (cumulative profit/investment/payout over the range) ---
  const dayKeys: string[] = []
  {
    const cursor = new Date(`${range.start}T00:00:00Z`)
    const endDate = new Date(`${range.end}T00:00:00Z`)
    while (cursor <= endDate) {
      dayKeys.push(ymd(cursor))
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }
  const profitByDay = new Map<string, number>()
  for (const l of realizedLines) {
    const d = istDateOf(l.realizedAt ?? '2000-01-01')
    profitByDay.set(d, (profitByDay.get(d) ?? 0) + l.profit)
  }
  // Investment placed on the money-event day, from the same realized +
  // unrealized lines totalInvested sums — so the cumulative investment line
  // ends exactly at totalInvested and matches the profit it sits under.
  const investmentByDay = new Map<string, number>()
  for (const l of realizedLines) {
    const d = istDateOf(l.realizedAt ?? '2000-01-01')
    investmentByDay.set(d, (investmentByDay.get(d) ?? 0) + (l.investedAmount ?? 0))
  }
  for (const l of unrealizedLines) {
    const d = istDateOf(l.allottedAt ?? '2000-01-01')
    investmentByDay.set(d, (investmentByDay.get(d) ?? 0) + l.investedAmount)
  }
  const payoutByDay = new Map<string, number>()
  for (const p of paymentsInRange) {
    const d = istDateOf(p.created_at)
    payoutByDay.set(d, (payoutByDay.get(d) ?? 0) + p.amount)
  }
  let cumProfit = 0
  let cumInvestment = 0
  let cumPayout = 0
  const trend: TrendPoint[] = dayKeys.map((d) => {
    const dailyProfit = profitByDay.get(d) ?? 0
    const dailyInvestment = investmentByDay.get(d) ?? 0
    const dailyPayout = payoutByDay.get(d) ?? 0
    cumProfit += dailyProfit
    cumInvestment += dailyInvestment
    cumPayout += dailyPayout
    return {
      date: d,
      dailyProfit,
      cumulativeProfit: cumProfit,
      dailyInvestment,
      cumulativeInvestment: cumInvestment,
      dailyPayout,
      cumulativePayout: cumPayout,
    }
  })

  // --- Payout status (this schema only ever has Paid/Pending — see the
  // module-level comment on why Failed/Processing don't exist here) ---
  const payoutStatus: PayoutStatusBreakdown = { paid: totalPayout, pending: pendingPayout }

  // --- Capital utilization ---
  // A PARTIALLY_SOLD row's bid_amount is split: the still-held fraction is
  // still locked, the sold fraction has been released.
  let lockedCapital = 0
  let releasedCapital = 0
  for (const r of payoutRowsInRange) {
    const bid = r.bid_amount ?? 0
    if (r.status === 'ALLOTTED') lockedCapital += bid
    else if (r.status === 'SOLD') releasedCapital += bid
    else if (r.status === 'PARTIALLY_SOLD') {
      const { totalShares, soldShares, remainingShares } = rowSellSplit(r)
      if (totalShares > 0) {
        lockedCapital += bid * (remainingShares / totalShares)
        releasedCapital += bid * (soldShares / totalShares)
      }
    }
  }
  const capital: CapitalUtilization = {
    invested: totalInvested,
    locked: lockedCapital,
    released: releasedCapital,
  }

  // --- Best/worst ---
  const sortedByProfit = [...ipoBreakdown].sort((a, b) => b.profit - a.profit)
  const best = sortedByProfit[0] ? { ipoName: sortedByProfit[0].ipoName, profit: sortedByProfit[0].profit, roi: sortedByProfit[0].roi } : null
  const worstRow = sortedByProfit[sortedByProfit.length - 1]
  const worst = worstRow && worstRow !== sortedByProfit[0] ? { ipoName: worstRow.ipoName, profit: worstRow.profit, roi: worstRow.roi } : null

  // --- Insights — only ever built from numbers already computed above;
  // never shown if the underlying data doesn't exist. ---
  const insights: string[] = []
  if (totalProfit !== 0) {
    insights.push(`You generated ${rupeesLocal(totalProfit)} profit in ${range.label}.`)
  }
  if (ipoBreakdown.length > 0) {
    const avgRoi = ipoBreakdown.reduce((s, r) => s + r.roi, 0) / ipoBreakdown.length
    insights.push(`Your average ROI per successful IPO was ${avgRoi.toFixed(1)}%.`)
  }
  if (best && best.profit > 0) {
    insights.push(`Your highest-profit IPO (${best.ipoName}) generated ${rupeesLocal(best.profit)}.`)
  }
  if (ipoBreakdown.length > 0) {
    const positive = ipoBreakdown.filter((r) => r.profit > 0).length
    insights.push(`${positive} out of ${ipoBreakdown.length} IPO${ipoBreakdown.length === 1 ? '' : 's'} generated positive returns.`)
  }

  return {
    range,
    summary,
    ipoBreakdown: ipoBreakdown.sort((a, b) => b.profit - a.profit),
    accountBreakdown,
    statusBreakdown,
    sharesByIpo,
    pendingByAccount,
    trend,
    payoutStatus,
    capital,
    best,
    worst,
    insights,
    realizedLines,
    unrealizedLines,
    ipoAccountBreakdown,
  }
}

const SETTLED_EPSILON_LOCAL = 1

function rupeesLocal(n: number): string {
  const sign = n < 0 ? '−' : ''
  return `${sign}₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`
}

// Re-exported so PayoutsPage doesn't need a second import for the same
// effectiveFunder resolution the account-wise breakdown implicitly depends
// on (via buildBookedProfitLines/buildUnrealizedProfitLines already using it
// internally) — kept here only so callers that need "who funded this row"
// for a raw row (outside the line-building functions) have one place to get
// it from, matching the rest of this module's "one calculation, reused"
// principle.
export { effectiveFunder }
export { parseGmpPercent }
