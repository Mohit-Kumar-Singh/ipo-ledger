import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  CheckCircleIcon,
  ClockIcon,
  LawIcon,
  CreditCardIcon,
  FileIcon,
  GraphIcon,
  LinkIcon,
} from '@primer/octicons-react'
import { IndianRupee } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchIpos, fetchDematAccounts, fetchAllotmentBoardAll, queryKeys } from '../../lib/queries'
import { useAuth } from '../../contexts/AuthContext'
import { Skeleton } from '../../components/PageSpinner'
import { IpoDashboardCard } from '../../components/IpoDashboardCard'
import { HoverCard } from '../../components/HoverCard'
import { bidCutoffMs, isLiveIpo, nowIst } from '../../lib/ipoStatus'
import { parseGmpPercent } from '../../lib/ipoGmp'
import { showToast } from '../../lib/toast'
import { computeProfitSplit, namesMatch, effectiveSplitWithFunder } from '../../lib/profitSplit'
import { computeIpoAttribution, sameIdentity, type IpoAttribution } from '../../lib/applicationAttribution'
import { resolveAttributionNames, topRecentIpoAttributionRows } from '../../lib/dashboardAttribution'
import {
  buildBookedProfitLines,
  buildFunderAllottedCards,
  expectedProfitBreakdown,
  rupees,
  type BookedProfitLine,
  type FunderAllottedCard,
  type ProfitProjectionRow,
} from '../../lib/expectedProfit'
import { useCountUp } from '../../lib/useCountUp'
import type {
  AllotmentBoardRow,
  ApplicationAttributionRow,
  DematAccount,
  Ipo,
  SettlementPayment,
} from '../../types/database'

interface PendingPayoutLine {
  applicationId: string
  ipoName: string
  amount: number
}

interface PendingPayout {
  name: string
  amount: number
  lines: PendingPayoutLine[]
}

interface IpoProgress {
  ipoId: string
  companyName: string
  openDate: string
  endDate: string
  closeDate: string
  allotmentDate: string | null
  listingDate: string | null
  applied: number
  totalActive: number
  gmpNotes: string | null
  subscriptionRate: string | null
  remainingHolderNames: string[]
  allottedCount: number
  shareholderIssueSize: string | null
  parentCompanyName: string | null
  parentCompanySymbol: string | null
}

const HIGH_GMP_THRESHOLD = 15

interface HighGmpAlert {
  ipoId: string
  companyName: string
  openDate: string
  gmpPercent: number
  gmpNotes: string
}

// One block per IPO, one line per funder within it — the funder is ALWAYS
// named (not just when an IPO has more than one), since hiding it for the
// single-funder case is exactly the bug that made Dhoot's funder (Avinash)
// silently disappear from the panel while another IPO's second funder
// showed up fine right next to it.
interface ExpectedProfitFunderLine {
  funderName: string
  holderNames: string
  profit: number
  // Invested + profit — the total figure to actually hand back to this
  // funder once it's sold, not just the profit slice. Shown as a smaller
  // secondary line under the profit amount. Absent for booked lines — once
  // it's actually sold there's nothing projected left to return-on-sale.
  amountToReturn?: number
  // True for a line built from an actual sell_price (buildBookedProfitLines)
  // rather than the GMP/live estimate — same person/IPO can have both a
  // booked line (lots already sold) and a projected one (lots still held)
  // side by side within one block.
  booked?: boolean
}
interface ExpectedProfitIpoBlock {
  ipoName: string
  funders: ExpectedProfitFunderLine[]
  // Whether this block's numbers are keyed off a live NSE quote (once the
  // IPO's symbol is set and resolvable) or the static GMP-based estimate —
  // surfaced in ExpectedProfitPanel so it's visible which basis produced
  // the figures, not silently swapped underneath the same-looking number.
  priceSource: 'live' | 'gmp'
  livePricePerShare: number | null
  // True when this IPO has already listed but has no symbol on file — the
  // GMP estimate it's stuck showing is a pre-listing number that stopped
  // updating the day trading opened, but the panel has no way to know a
  // more accurate live price is possible until an admin fills in the
  // symbol field (ipoji never scrapes one; it's manual, see IposPage).
  needsSymbolForLivePrice: boolean
}

interface DashboardData {
  closingToday: Ipo[]
  pendingMandate: AllotmentBoardRow[]
  allottedNotSold: AllotmentBoardRow[]
  attribution: IpoAttribution[]
  ipoProgress: IpoProgress[]
  highGmpAlerts: HighGmpAlert[]
  pendingPayouts: PendingPayout[]
  overpaidToFunders: PendingPayout[]
  totalApplied: number
  // Sum of projected net profit (your half, after the demat holder's cut)
  // across every currently-ALLOTTED-but-not-yet-sold application with a
  // price band on file — same per-lot math as NotificationsPage's funder
  // "Allotment updates" cards (buildFunderAllottedCards/expectedProfitBreakdown,
  // shared via lib/expectedProfit.ts so the two numbers can't drift apart).
  // Deliberately excludes SOLD applications — that real, booked profit lives
  // on the Payouts page (Realized/My profit), not here, so a confirmed
  // number is never shown inside a tile labeled "Expected."
  expectedProfitTotal: number
  expectedProfitByIpo: ExpectedProfitIpoBlock[]
}

// Below a rupee is just floating-point noise from the split math, not a
// real outstanding balance — same threshold PayoutsPage uses for the exact
// same reason (SETTLED_EPSILON there).
const PENDING_PAYOUT_EPSILON = 1

// Sums, per funder, what you still need to send them out of already-sold
// applications — using the live settlement ledger (settlement_payments),
// same as the Payouts page's own settlement cards, not the old
// demat_cut_paid/funder_share_paid boolean flags this used to read. Those
// flags tracked a DIFFERENT, now-obsolete obligation: the old model assumed
// the holder sent back the full sale proceeds and you paid their cut back
// out separately afterward. The current model has the holder keep their
// own cut before sending anything on — there's no separate "pay the holder
// back" step anymore, so that half of the old tracking doesn't apply to
// any real obligation under the model actually in use; only the funder
// side (bidAmount + their profit share, minus whatever's already been
// logged as sent) is still something you can genuinely still owe.
function buildPendingPayouts(
  soldRows: AllotmentBoardRow[],
  profitPersonName: string,
  paymentsByApp: Map<string, SettlementPayment[]>,
): { pending: PendingPayout[]; overpaid: PendingPayout[] } {
  const byName = new Map<string, PendingPayoutLine[]>()
  const add = (name: string, line: PendingPayoutLine) => {
    const lines = byName.get(name) ?? []
    lines.push(line)
    byName.set(name, lines)
  }
  for (const r of soldRows) {
    if (r.sell_price == null) continue
    const result = computeProfitSplit({
      sellPricePerShare: r.sell_price,
      lotSize: r.lot_size,
      lots: r.lots,
      bidAmount: r.bid_amount ?? 0,
      // demat_accounts has no funder-visibility RLS policy at all (only
      // linked_user_id = auth.uid()) — a funder viewing their OWN
      // "Owed to you" tile isn't linked to the demat account they funded,
      // so v_allotment_board's join to it is silently blocked for exactly
      // that row, and profit_share_percent comes back null (unlike
      // holder_name, which survives via a separate RLS-bypassing resolver
      // function). null/100 evaluates to 0 in JS, which skipped the demat
      // holder's cut entirely and inflated a real funder's own payout by
      // half the missing cut — confirmed live (₹17,086 shown instead of
      // the correct ₹16,560). Same ?? 25 fallback buildFunderAllottedCards
      // already uses for this exact situation.
      cutPercent: r.profit_share_percent ?? 25,
      dematHolderName: r.holder_name,
      funderName: r.bank_account_holder_name,
      profitPersonName,
      splitWithFunder: effectiveSplitWithFunder(r, r.split_profit_with_funder),
    })
    // A CASE_2 shared account's manager IS its funder (migration 0079) —
    // there's no separate third-party funder owed anything for it; their
    // bidAmount return already flows through the holder-side settlement
    // (PayoutsPage's amountFromHolder), not this funder-owed ledger.
    if (!result.hasFunder || result.isFunderSelf || r.account_manager_case_type === 'CASE_2') continue
    const amountToFunder = (r.bid_amount ?? 0) + result.funderShare
    if (amountToFunder <= 0) continue
    // A holder_to_funder payment counts too — it's money that reached the
    // funder even though it never passed through you, same reasoning as
    // PayoutsPage's own sentToFunder calculation.
    const sentToFunder = (paymentsByApp.get(r.application_id) ?? [])
      .filter((p) => p.kind === 'admin_to_funder' || p.kind === 'holder_to_funder')
      .reduce((s, p) => s + p.amount, 0)
    const remainingToFunder = amountToFunder - sentToFunder
    // Not skipped when negative (overpaid) — kept in the same per-funder
    // group so it nets against anything else still owed to that funder,
    // same as the settlement cards on Payouts already do per application.
    if (Math.abs(remainingToFunder) <= PENDING_PAYOUT_EPSILON) continue
    add(r.bank_account_holder_name ?? 'Unknown', {
      applicationId: r.application_id,
      ipoName: r.company_name,
      amount: remainingToFunder,
    })
  }
  const groups = Array.from(byName.entries()).map(([name, lines]) => ({
    name,
    amount: lines.reduce((s, l) => s + l.amount, 0),
    lines,
  }))
  return {
    pending: groups.filter((g) => g.amount > PENDING_PAYOUT_EPSILON).sort((a, b) => b.amount - a.amount),
    // Net negative — you're owed this back. Amounts flipped positive for display.
    overpaid: groups
      .filter((g) => g.amount < -PENDING_PAYOUT_EPSILON)
      .map((g) => ({ name: g.name, amount: -g.amount, lines: g.lines.map((l) => ({ ...l, amount: -l.amount })) }))
      .sort((a, b) => b.amount - a.amount),
  }
}

// One block per IPO, one line per funder within it — funder is always
// named, every time, no matter how many funder cards an IPO has. Confirmed
// bug in the earlier version: it only prefixed "from {funder}" when an IPO
// had MORE than one funder card, so a single-funder IPO's funder name
// (e.g. Dhoot funded by Avinash) silently vanished from the panel while a
// two-funder IPO right next to it showed both names fine.
function buildExpectedProfitByIpo(
  cards: FunderAllottedCard[],
  livePriceBySymbol: Record<string, number | null>,
  todayStr: string,
  bookedLines: BookedProfitLine[],
  // Which share to show: netYourProfit (the profit-TAKING admin's own cut)
  // for an admin viewer, or funderShare/funderShareTotal (the FUNDER's own
  // share) when the viewer IS that funder — showing an admin's-cut number
  // to a funder as "your expected profit" told them the wrong person's
  // money. See BookedProfitLine.funderShare's own comment.
  isAdmin: boolean,
): ExpectedProfitIpoBlock[] {
  const byIpo = new Map<string, ExpectedProfitIpoBlock>()
  for (const c of cards) {
    const livePrice = c.symbol ? (livePriceBySymbol[c.symbol] ?? null) : null
    if (!byIpo.has(c.ipoName)) {
      byIpo.set(c.ipoName, {
        ipoName: c.ipoName,
        funders: [],
        priceSource: livePrice != null ? 'live' : 'gmp',
        livePricePerShare: livePrice,
        needsSymbolForLivePrice: livePrice == null && !!c.listingDate && todayStr >= c.listingDate && !c.symbol,
      })
    }
    const b = expectedProfitBreakdown(c, livePrice)
    byIpo.get(c.ipoName)!.funders.push({
      funderName: c.funderName,
      holderNames: c.holderNames.map((h) => h.name).join(', '),
      profit: isAdmin ? b.netYourProfit : b.funderShareTotal,
      amountToReturn: b.amountToReturn,
    })
  }
  // Booked (realized) lines merge into the same per-IPO block, grouped by
  // funder — an IPO can have both still-projected lots (above) and already-
  // sold ones for the same funder, and a fully-sold IPO with no ALLOTTED
  // lots left at all needs its own block created here, since the loop above
  // never saw it (no FunderAllottedCard exists for it).
  const bookedByIpoFunder = new Map<string, { holderNames: Set<string>; profit: number }>()
  for (const l of bookedLines) {
    const key = `${l.ipoName}::${l.funderName}`
    const entry = bookedByIpoFunder.get(key) ?? { holderNames: new Set<string>(), profit: 0 }
    entry.holderNames.add(l.holderName)
    entry.profit += isAdmin ? l.profit : l.funderShare
    bookedByIpoFunder.set(key, entry)
  }
  for (const [key, entry] of bookedByIpoFunder) {
    const [ipoName, funderName] = key.split('::')
    if (!byIpo.has(ipoName)) {
      byIpo.set(ipoName, {
        ipoName,
        funders: [],
        priceSource: 'gmp',
        livePricePerShare: null,
        needsSymbolForLivePrice: false,
      })
    }
    byIpo.get(ipoName)!.funders.push({
      funderName,
      holderNames: Array.from(entry.holderNames).join(', '),
      profit: entry.profit,
      booked: true,
    })
  }
  return Array.from(byIpo.values())
}

export function DashboardPage() {
  const { profile } = useAuth()
  const queryClient = useQueryClient()
  const isAdmin = profile?.role === 'admin'
  // Includes profile?.id (not just isAdmin) so the cache key changes the
  // instant a DIFFERENT signed-in user's data would need to be shown —
  // isAdmin alone can't distinguish two different funder-only members, and
  // TanStack's cache is keyed on this array, not on "whoever happens to be
  // signed in right now."
  // useMemo, not a plain array literal — this is listed in the realtime
  // effect's dependency array below, and a fresh array object on every
  // render (React compares array deps by reference, not by value) would
  // have torn down and rebuilt the realtime channel + 5-minute poll on
  // every single re-render of this page (e.g. every time markingPaid or
  // expandedIpoIds changes), not just when the viewer actually changes.
  // useQuery's own queryKey option doesn't have this problem — TanStack
  // hashes it by value internally — but this same array is reused there
  // too, so memoizing it once covers both.
  const dashboardQueryKey = useMemo(
    () => ['dashboard', profile?.id ?? null, isAdmin] as const,
    [profile?.id, isAdmin],
  )
  const [markingPaid, setMarkingPaid] = useState<string | null>(null)
  // A Set, not a single "currently expanded" id — each IpoDashboardCard
  // owns its own expand state and several can be open across the grid at
  // once, independent of each other, not a single shared panel that only
  // one card at a time can claim.
  const [expandedIpoIds, setExpandedIpoIds] = useState<Set<string>>(new Set())
  const [parentPrices, setParentPrices] = useState<Record<string, { price: number | null; stale: boolean }>>({})
  function toggleExpanded(ipoId: string) {
    setExpandedIpoIds((s) => {
      const next = new Set(s)
      if (next.has(ipoId)) next.delete(ipoId)
      else next.add(ipoId)
      return next
    })
  }
  // Fires the high-GMP heads-up as a toast once per calendar day, not on
  // every visit to (or realtime-triggered reload of) the Dashboard — a
  // plain useRef only survives while this component stays mounted, so
  // navigating away and back (or a page reload) reset it and re-fired the
  // toast on every single visit. localStorage persists across all of that;
  // the guard is "have we already shown it today," not "this mount."
  const hasShownGmpToast = useRef(localStorage.getItem('gmpToastShownDate') === nowIst().dateStr)
  // Same once-per-day-via-localStorage guard as the GMP toast above, for the
  // listing-day reminder ("go mark these sold") and the mandate-cutoff
  // warning ("approve these before 4:50pm").
  const hasShownListingToast = useRef(localStorage.getItem('listingToastShownDate') === nowIst().dateStr)
  const hasShownMandateCutoffToast = useRef(localStorage.getItem('mandateCutoffToastShownDate') === nowIst().dateStr)

  // Logs a settlement_payments row instead of flipping a boolean flag —
  // pendingPayouts is now built off that same live ledger (see
  // buildPendingPayouts), so this has to write to the thing that ledger
  // actually reads, same as PayoutsPage's own log-a-payment form does.
  async function markPayoutPaid(line: PendingPayoutLine) {
    setMarkingPaid(line.applicationId)
    const { error } = await supabase
      .from('settlement_payments')
      .insert({ application_id: line.applicationId, kind: 'admin_to_funder', amount: line.amount })
    setMarkingPaid(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    // queryClient.setQueryData, not a local setData — data now lives in
    // the dashboardQuery cache (below), not component state, so this has
    // to patch the SAME place a background refetch would write to.
    queryClient.setQueryData(dashboardQueryKey, (d: DashboardData | undefined) => {
      if (!d) return d
      const pendingPayouts = d.pendingPayouts
        .map((p) => ({
          ...p,
          lines: p.lines.filter((l) => l.applicationId !== line.applicationId),
        }))
        .map((p) => ({ ...p, amount: p.lines.reduce((s, l) => s + l.amount, 0) }))
        .filter((p) => p.lines.length > 0)
      return { ...d, pendingPayouts }
    })
  }

  // dashboardQueryKey (defined above, next to isAdmin) is what makes
  // this stale-while-revalidate instead of a spinner-on-every-visit:
  // navigating back to Dashboard within staleTime reuses the SAME cache
  // entry TanStack already has, rendering the previous numbers
  // immediately (isPending stays false) while a background refetch (if
  // the entry is actually stale) updates them in place once it lands —
  // no full-page skeleton on a revisit, only on a genuinely first-ever
  // load this session. Previously `data`/`loading` were plain component
  // state, wiped to null/true on every mount because this route fully
  // unmounts on navigation (React Router) — that's what forced the
  // skeleton to render on every single visit regardless of how recently
  // the same data had already been fetched.
  const dashboardQuery = useQuery({
    queryKey: dashboardQueryKey,
    queryFn: async (): Promise<DashboardData> => {
    // IST, not the device/browser/server's own local date — a plain
    // `new Date().toISOString().slice(0, 10)` reads UTC, which is still
    // "yesterday" for the first 5.5 hours of every IST day (00:00-05:29
    // IST = the previous UTC date). That's exactly what made an IPO that
    // actually closed the day before still show up under "closing today."
    const todayStr = nowIst().dateStr

    // Link requests moved off the Dashboard entirely (review now lives on
    // Profile, with a toast on arrival instead of a permanent tile/list
    // here — see ToastHost) — no longer fetched on this page at all.
    // ipos/demat_accounts/v_allotment_board now come from the shared
    // cache (lib/queries.ts) via fetchQuery — resolves from cache
    // instantly if another page (or Dashboard's own last load) already
    // fetched it within the staleTime window, or fetches and populates
    // the shared cache if not. Previously this fired TWO separate ipos
    // queries in the same Promise.all (closingToday AND allIpos, both
    // full/near-full table reads) plus its own independent
    // demat_accounts and v_allotment_board queries, none of which were
    // shared with any other page. closingToday/activeAccounts are
    // derived client-side from the same fetched lists rather than their
    // own filtered network query.
    const [allIposData, dematAccountsData, boardData, attributionRes, profitRows, settlementPaymentsRes, case2ManagersRes] = await Promise.all([
      queryClient.fetchQuery({ queryKey: queryKeys.ipos, queryFn: fetchIpos }),
      queryClient.fetchQuery({ queryKey: queryKeys.dematAccounts, queryFn: fetchDematAccounts }),
      queryClient.fetchQuery({ queryKey: queryKeys.allotmentBoard, queryFn: fetchAllotmentBoardAll, staleTime: 15_000 }),
      supabase.from('v_application_attribution').select('*'),
      // Same row shape/query NotificationsPage's admin-only funder query
      // uses (see lib/expectedProfit.ts's ProfitProjectionRow) — no
      // client-side role gate: RLS (p_apps_member_funder_select,
      // migration 0032) already scopes this correctly per viewer — admin
      // gets every funded application, a funder-only member gets just
      // the ones where their own bank/UPI account is the funder. Letting
      // RLS do the scoping (instead of an isAdmin ? ... : [] gate
      // pretending to be the security boundary) is what actually lets a
      // funder see their own expected profit on their own Dashboard.
      supabase
        .from('applications')
        .select(
          'ipo_id, lots, applied_at, status, mandate_status, ipoji_status_text, bid_amount, sell_price, split_profit_with_funder, ' +
            'ipos(company_name, open_date, close_date, listing_date, price_high, lot_size, gmp_notes, is_archived, symbol), ' +
            'demat_accounts(holder_name, profit_share_percent, phone_e164, account_manager_id), ' +
            'bank_accounts!bank_account_id(account_holder_name, phone_e164, upi_id), ' +
            'funder_override:bank_accounts!funder_override_id(account_holder_name, phone_e164, upi_id)',
        )
        .in('status', ['ALLOTTED', 'SOLD'])
        .or('bank_account_id.not.is.null,funder_override_id.not.is.null'),
      // Live remaining-to-funder figures for pendingPayouts below (same
      // ledger PayoutsPage's settlement cards read) — genuinely
      // admin-only at the RLS level (p_settlement_payments_admin,
      // migration 0078), so fetching this unconditionally is harmless: a
      // non-admin viewer just always gets back zero rows here, same as
      // if this were still client-gated, just without a client-side
      // branch pretending to be the actual security boundary.
      supabase.from('settlement_payments').select('*'),
      // Shared-account CASE_2 managers (migration 0079) — their remaining
      // profit share shouldn't get halved with a nonexistent third-party
      // funder in the projections below. Admin sees every manager;
      // a funder-only viewer who happens to BE a linked manager sees just
      // their own row via p_account_managers_self, which is all this needs.
      supabase.from('account_managers').select('id').eq('case_type', 'CASE_2'),
    ])

    // Top 8 most-recently-opened IPOs (Profile mirrors the top 4 of this
    // same ordering) — resolving names is a second round trip since it
    // depends on which ids show up in that scoped set.
    const scopedRows = topRecentIpoAttributionRows((attributionRes.data ?? []) as ApplicationAttributionRow[], 8)
    const nameById = await resolveAttributionNames(scopedRows)

    // Archived IPOs (settled + moved to /archives) shouldn't keep showing
    // up in "Awaiting mandate approval," "Allotted, not sold," or
    // "Payouts pending" — those tiles are for what's still live, not a
    // running history of everything that ever happened.
    const boardRows = boardData.filter((r) => !r.ipo_is_archived)

    const settlementPaymentsByApp = new Map<string, SettlementPayment[]>()
    for (const p of (settlementPaymentsRes.data ?? []) as SettlementPayment[]) {
      if (!settlementPaymentsByApp.has(p.application_id)) settlementPaymentsByApp.set(p.application_id, [])
      settlementPaymentsByApp.get(p.application_id)!.push(p)
    }

    // Applied-per-IPO accounts come from the board rows already fetched above
    // (one row per application) rather than a separate query — v_allotment_board
    // already covers every IPO, not just the top-8-by-open-date attribution set.
    const appliedDematIdsByIpo = new Map<string, Set<string>>()
    for (const r of boardRows) {
      // A CANCELLED mandate means the funder never actually approved the
      // UPI block — no money moved, so this account hasn't really applied
      // in any way that should block it from the "accounts left" list.
      // Same reasoning as Settings' "Cancelled mandates — can reapply"
      // section; this is that same account showing up as still-available
      // here instead of silently counting as done.
      if (r.mandate_status === 'CANCELLED') continue
      if (!appliedDematIdsByIpo.has(r.ipo_id)) appliedDematIdsByIpo.set(r.ipo_id, new Set())
      appliedDematIdsByIpo.get(r.ipo_id)!.add(r.demat_id)
    }
    // Distinct demat accounts marked ALLOTTED (or already SOLD — still
    // allotted, just further along) per IPO — feeds the Dashboard card's
    // "N allotted" badge that deep-links into that IPO's allotment board.
    const allottedCountByIpo = new Map<string, number>()
    for (const r of boardRows) {
      if (r.status !== 'ALLOTTED' && r.status !== 'SOLD') continue
      allottedCountByIpo.set(r.ipo_id, (allottedCountByIpo.get(r.ipo_id) ?? 0) + 1)
    }
    // An IPO drops out of the progress cards once EVERY row of it this
    // viewer can see (their own rows only, for a funder-only viewer —
    // RLS scopes boardRows that way already; every row, for admin) came
    // back NOT_ALLOTTED more than a day ago — rather than sitting there
    // until the IPO's own listing date (isLiveIpo's window). Real case
    // this fixes: Dhoot Transmission funded by several different people,
    // some allotted and some not — a funder whose OWN application was
    // rejected shouldn't keep seeing this IPO's progress card a day
    // later just because someone else's application under it is still
    // live, and the same viewer-scoped check correctly keeps it visible
    // for the funders whose applications DID get allotted.
    const ONE_DAY_MS = 24 * 60 * 60 * 1000
    const rowsByIpo = new Map<string, AllotmentBoardRow[]>()
    for (const r of boardRows) {
      if (!rowsByIpo.has(r.ipo_id)) rowsByIpo.set(r.ipo_id, [])
      rowsByIpo.get(r.ipo_id)!.push(r)
    }
    const staleNotAllottedIpoIds = new Set(
      Array.from(rowsByIpo.entries())
        .filter(([, ipoRows]) =>
          ipoRows.every(
            (r) => r.status === 'NOT_ALLOTTED' && Date.now() - new Date(r.status_changed_at).getTime() > ONE_DAY_MS,
          ),
        )
        .map(([ipoId]) => ipoId),
    )

    const activeDematAccounts = dematAccountsData.filter((a) => a.is_active) as Pick<DematAccount, 'id' | 'holder_name'>[]
    const totalActive = activeDematAccounts.length
    const ipoProgress: IpoProgress[] = allIposData
      .filter(isLiveIpo)
      .map((ipo) => {
        const appliedIds = appliedDematIdsByIpo.get(ipo.id) ?? new Set<string>()
        const remainingHolderNames = activeDematAccounts
          .filter((d) => !appliedIds.has(d.id))
          .map((d) => d.holder_name)
          .sort((a, b) => a.localeCompare(b))
        return {
          ipoId: ipo.id,
          companyName: ipo.company_name,
          openDate: ipo.open_date,
          endDate: ipo.listing_date ?? ipo.close_date,
          closeDate: ipo.close_date,
          allotmentDate: ipo.allotment_date,
          listingDate: ipo.listing_date,
          applied: appliedIds.size,
          totalActive,
          gmpNotes: ipo.gmp_notes,
          subscriptionRate: ipo.retail_subscription_rate,
          remainingHolderNames,
          allottedCount: allottedCountByIpo.get(ipo.id) ?? 0,
          shareholderIssueSize: ipo.shareholder_issue_size,
          parentCompanyName: ipo.parent_company_name,
          parentCompanySymbol: ipo.parent_company_symbol,
        }
      })
      // No point showing a progress tile for an IPO nobody has applied to
      // yet — it's not "in progress," there's nothing to track. Nor for
      // one this viewer's own visible applications have already settled
      // as NOT_ALLOTTED a day or more ago (see staleNotAllottedIpoIds).
      .filter((p) => p.applied > 0 && !staleNotAllottedIpoIds.has(p.ipoId))
      // Most recently opened first, not soonest-closing first — the
      // latest IPO is what someone's actually here to check on.
      .sort((a, b) => b.openDate.localeCompare(a.openDate))

    // Same 15% line the gmp-alert-notify cron uses for the WhatsApp
    // heads-up (2 days / 1 day before open) — shown here so it's visible
    // in the UI too, not just via WhatsApp.
    const todayForGmp = todayStr
    // +2 days off the already-IST-correct todayStr, not off a fresh
    // UTC-based Date.now() — same rollover bug as the closingToday fix
    // above would otherwise sneak back in here.
    const in2DaysForGmp = new Date(`${todayStr}T00:00:00Z`)
    in2DaysForGmp.setUTCDate(in2DaysForGmp.getUTCDate() + 2)
    const in2DaysForGmpStr = in2DaysForGmp.toISOString().slice(0, 10)
    const highGmpAlerts: HighGmpAlert[] = allIposData
      .filter((ipo) => ipo.open_date >= todayForGmp && ipo.open_date <= in2DaysForGmpStr)
      .map((ipo) => ({ ipo, gmpPercent: parseGmpPercent(ipo.gmp_notes) }))
      .filter((x): x is { ipo: Ipo; gmpPercent: number } => x.gmpPercent !== null && x.gmpPercent > HIGH_GMP_THRESHOLD)
      .map(({ ipo, gmpPercent }) => ({
        ipoId: ipo.id,
        companyName: ipo.company_name,
        openDate: ipo.open_date,
        gmpPercent,
        gmpNotes: ipo.gmp_notes ?? '',
      }))
      .sort((a, b) => a.openDate.localeCompare(b.openDate))

    if (!hasShownGmpToast.current && highGmpAlerts.length > 0) {
      hasShownGmpToast.current = true
      localStorage.setItem('gmpToastShownDate', todayForGmp)
      for (const a of highGmpAlerts) {
        const daysOut = Math.round(
          (new Date(`${a.openDate}T00:00:00Z`).getTime() - new Date(todayForGmp + 'T00:00:00Z').getTime()) / 86400000,
        )
        showToast(
          `${a.companyName} opens ${daysOut <= 0 ? 'today' : `in ${daysOut} day${daysOut === 1 ? '' : 's'}`} (${a.openDate}) with GMP running high at ${a.gmpPercent}% (${a.gmpNotes}).`,
          'warning',
        )
      }
    }

    // Listing-day reminder — fires both the day BEFORE (so there's still
    // time to plan) and the day OF (the actual moment to go check the
    // opening price and decide whether to sell) an allotted-not-sold
    // application's IPO listing — not just the day-of, which only gave a
    // few hours' notice. isAdmin-gated the same as the other
    // funder/payout-facing toasts below — a member's own listing-day
    // holdings still show on the Dashboard tile itself either way.
    if (isAdmin && !hasShownListingToast.current) {
      const tomorrow = new Date(`${todayStr}T00:00:00Z`)
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
      const tomorrowStr = tomorrow.toISOString().slice(0, 10)

      const listingTodayRows = boardRows.filter((r) => r.status === 'ALLOTTED' && r.listing_date === todayStr)
      const listingTomorrowRows = boardRows.filter((r) => r.status === 'ALLOTTED' && r.listing_date === tomorrowStr)

      if (listingTodayRows.length > 0 || listingTomorrowRows.length > 0) {
        hasShownListingToast.current = true
        localStorage.setItem('listingToastShownDate', todayStr)
        if (listingTodayRows.length > 0) {
          const names = Array.from(new Set(listingTodayRows.map((r) => r.holder_name))).join(', ')
          const ipoNames = Array.from(new Set(listingTodayRows.map((r) => r.company_name))).join(', ')
          showToast(`${ipoNames} lists today — ${names} still need to be marked sold once you have a price.`, 'info')
        }
        if (listingTomorrowRows.length > 0) {
          const names = Array.from(new Set(listingTomorrowRows.map((r) => r.holder_name))).join(', ')
          const ipoNames = Array.from(new Set(listingTomorrowRows.map((r) => r.company_name))).join(', ')
          showToast(`${ipoNames} lists tomorrow — ${names} will need to be marked sold once it opens.`, 'info')
        }
      }
    }

    // Mandate-cutoff warning — a mandate still PENDING as the 4:50pm IST
    // cutoff approaches (within the last hour of the window) needs a
    // human to go approve it NOW, not just quietly drop out of the
    // "Awaiting mandate approval" count once the window closes. Fires
    // once the same-day window is actually close (not the whole day),
    // so it means something when it shows up.
    if (isAdmin && !hasShownMandateCutoffToast.current) {
      const { dateStr, hour, minute } = nowIst()
      const minutesToCutoff = 16 * 60 + 50 - (hour * 60 + minute)
      if (minutesToCutoff > 0 && minutesToCutoff <= 60) {
        const stillPending = boardRows.filter((r) => r.mandate_status === 'PENDING' && r.close_date === dateStr)
        if (stillPending.length > 0) {
          hasShownMandateCutoffToast.current = true
          localStorage.setItem('mandateCutoffToastShownDate', dateStr)
          const names = Array.from(new Set(stillPending.map((r) => r.holder_name))).join(', ')
          showToast(
            `Bidding closes at 4:50 PM — ${names} still ${stillPending.length === 1 ? 'has' : 'have'} a mandate awaiting approval.`,
            'warning',
          )
        }
      }
    }

    // Archived is NOT filtered out here (used to be) — archiving only ever
    // happens once every row on an IPO is fully resolved, but "resolved"
    // includes NOT_ALLOTTED siblings; an IPO can still archive while some of
    // ITS OWN allotted shares haven't been sold yet, or were sold but never
    // filtered out of this fetch's own scope. That combination used to make
    // both the still-projected (ALLOTTED) and already-realized (SOLD, via
    // buildBookedProfitLines) profit on those shares silently vanish from
    // the Dashboard the moment the IPO archived — real money the app just
    // stopped counting, with nothing to un-archive it back into view. Cards
    // with no price band on file are still skipped below (same guard the
    // WhatsApp message itself uses — nothing sane to project without one).
    const profitRowsBase = (profitRows.data ?? []) as unknown as ProfitProjectionRow[]
    const case2ManagerIds = new Set((case2ManagersRes.data ?? []).map((m) => m.id as string))
    const profitCards = buildFunderAllottedCards(
      profitRowsBase.filter((r) => r.status === 'ALLOTTED'),
      sameIdentity,
      case2ManagerIds,
    ).filter((c) => c.priceHigh)
    const bookedProfitLines = buildBookedProfitLines(profitRowsBase, profile?.full_name ?? '', case2ManagerIds)

    // Once an IPO actually lists, its GMP-based profit estimate is frozen
    // at whatever the grey-market premium read pre-listing — a real share
    // price that keeps moving daily until someone marks the application
    // SOLD. Resolving each card's own symbol against the same live-quote
    // mechanism the parent-company badge uses keeps "Expected profit"
    // tracking that movement instead of showing a stale number.
    const profitSymbols = Array.from(new Set(profitCards.map((c) => c.symbol).filter((s): s is string => !!s)))
    const livePriceBySymbol: Record<string, number | null> = {}
    if (profitSymbols.length > 0) {
      const { data: priceData } = await supabase.functions.invoke<{
        prices?: Record<string, { price: number | null; stale: boolean }>
      }>('fetch-stock-price', { body: { symbols: profitSymbols } })
      for (const [sym, p] of Object.entries(priceData?.prices ?? {})) livePriceBySymbol[sym] = p.price
    }

    // Projected only — ALLOTTED, not yet sold. Used to also add
    // bookedProfitLines (already-SOLD) into this same total, which meant a
    // real, confirmed number sat inside a tile labeled "Expected," implying
    // it was still just a guess. That real/booked figure lives on the
    // Payouts page (Realized/My profit) instead — the two are never summed
    // into one figure here, same "never blended" rule Payouts' Realized/
    // Unrealized split already follows.
    //
    // netYourProfit for admin, funderShareTotal for a funder viewer — the
    // fetch is already RLS-scoped to just their own cards, but the FIGURE
    // itself used to always be netYourProfit (the profit-taking admin's own
    // cut), which told a funder the wrong person's money was "their"
    // expected profit. Confirmed live: a funder saw a number here that
    // didn't match their own share shown elsewhere in the portal.
    const expectedProfitTotal = profitCards.reduce(
      (sum, c) => {
        const b = expectedProfitBreakdown(c, c.symbol ? livePriceBySymbol[c.symbol] : null)
        return sum + (isAdmin ? b.netYourProfit : b.funderShareTotal)
      },
      0,
    )
    const expectedProfitByIpo = buildExpectedProfitByIpo(profitCards, livePriceBySymbol, todayStr, bookedProfitLines, isAdmin)

    // Real mandate_status (0047/0048), not the previous proxy of "every
    // still-APPLIED application" — that counted plenty of applications
    // whose mandate was already approved and were just waiting on
    // allotment, nothing to do with mandate status at all. Further
    // narrowed to only mandates that can STILL actually be approved —
    // approval on the sponsor bank's side has to happen before bidding
    // itself cuts off (4:50pm IST on the IPO's close_date, same cutoff
    // isOpenForBidding/hasBiddingClosed enforce for applying); a mandate
    // still PENDING after that point isn't "awaiting action" anymore,
    // there's no window left to act in.
    const actionablePendingMandate = boardRows.filter(
      (r) => r.mandate_status === 'PENDING' && Date.now() <= bidCutoffMs(r.close_date),
    )

    const pendingPayoutsResult = buildPendingPayouts(
      boardRows.filter((r) => r.status === 'SOLD'),
      isAdmin ? (profile?.full_name ?? '') : '',
      settlementPaymentsByApp,
    )

    // Once an IPO's allotment IS out, a row still stuck at APPLIED for that
    // same IPO isn't "pending a decision" anymore — the decision already
    // happened, this one just never got flipped. Counting it as live
    // overstates how many applications are actually still open, so once an
    // IPO is decided, only its ALLOTTED/SOLD rows count toward totalApplied
    // below — a leftover APPLIED row closes right along with the IPO's
    // NOT_ALLOTTED ones. "Decided" is two independent signals, either one
    // enough: (1) any sibling row for the same IPO already sitting at
    // ALLOTTED/NOT_ALLOTTED/SOLD — works for admin, who sees every account;
    // (2) the IPO's own listing_date has passed — listing always happens
    // after allotment, so this still catches a member viewer whose only
    // application to that IPO is the stale one, with no visible sibling row
    // to compare against (boardRows is RLS-scoped to their own accounts).
    const decidedIpoIds = new Set(
      boardRows
        .filter((r) => r.status === 'ALLOTTED' || r.status === 'NOT_ALLOTTED' || r.status === 'SOLD' || (!!r.listing_date && r.listing_date <= todayStr))
        .map((r) => r.ipo_id),
    )

    return {
      // Derived client-side instead of its own `.eq('close_date', todayStr)`
      // network query — same source array as ipoProgress/highGmpAlerts above.
      closingToday: allIposData.filter((i) => i.close_date === todayStr).sort((a, b) => a.company_name.localeCompare(b.company_name)),
      pendingMandate: actionablePendingMandate,
      allottedNotSold: boardRows.filter((r) => r.status === 'ALLOTTED'),
      attribution: computeIpoAttribution(scopedRows, nameById).sort((a, b) => b.openDate.localeCompare(a.openDate)),
      ipoProgress,
      highGmpAlerts,
      expectedProfitTotal,
      expectedProfitByIpo,
      // boardRows (v_allotment_board) is already RLS-scoped per viewer —
      // a funder-only member only ever sees rows they're associated
      // with, so this naturally comes back as just their own entry (or
      // entries, if they fund via more than one bank/UPI account) rather
      // than needing a separate computation path.
      //
      // profitPersonName is empty for a non-admin, NOT profile.full_name
      // — computeProfitSplit (inside buildPendingPayouts) uses this name
      // to detect "is the funder ALSO the profit-taking admin" (isFunderSelf),
      // which zeroes their payout when true. Passing a funder's OWN name
      // here would make that comparison match their own funder row,
      // spuriously zeroing what they're owed — a non-admin viewer is
      // never the profit-taking admin by construction (they'd see the
      // admin view instead if they were), and profiles RLS doesn't even
      // let them look up the real admin's name to compare against
      // correctly, so forcing this comparison to never match is the
      // correct behavior here, not a workaround.
      pendingPayouts: pendingPayoutsResult.pending,
      overpaidToFunders: pendingPayoutsResult.overpaid,
      // A CANCELLED mandate means the funder never actually approved the
      // UPI block — no money moved, so it's not really "applied" in any
      // sense worth counting here (same reasoning as the accounts-left
      // fix above). boardRows is already RLS-scoped per viewer (every
      // account for admin, just this member's own for a member), so this
      // reads as "how many IPOs has admin/this member applied to" either
      // way, matching the section's own "across all accounts"/"your
      // accounts" framing. NOT_ALLOTTED is excluded too — once an IPO's
      // allotment result is out, an application that didn't get shares
      // isn't a "current" application anymore, just a closed-out record
      // (still visible on the Applications page, just not counted here).
      // decidedIpoIds (above) excludes stale APPLIED stragglers on an
      // already-decided IPO the same way.
      totalApplied: boardRows.filter(
        (r) =>
          r.mandate_status !== 'CANCELLED' &&
          r.status !== 'NOT_ALLOTTED' &&
          !(r.status === 'APPLIED' && decidedIpoIds.has(r.ipo_id)),
      ).length,
    }
    },
    // Same reasoning as v_allotment_board's own staleTime (lib/queries.ts)
    // — this is backed by the same realtime-tracked applications table
    // (plus several tables that aren't realtime-tracked at all), and is
    // ALSO explicitly invalidated by the realtime handler and the
    // 5-minute poll below, so this mainly governs "how stale can it get
    // if neither of those two things has fired yet."
    staleTime: 15_000,
  })
  const data = dashboardQuery.data ?? null
  // isPending, not isLoading/isFetching — true only when this query has
  // NEVER successfully resolved in this session (no cached data to show
  // at all), which is the one case that actually needs a full-page
  // skeleton. A background refetch (stale entry, realtime event, the
  // 5-min poll) leaves isPending false and data holding the previous
  // values the whole time it runs.
  const loading = dashboardQuery.isPending

  useEffect(() => {
    // Live-refresh whenever an application changes — e.g. a member's
    // dashboard should reflect the instant an admin creates/edits an
    // application funded by that member's linked bank/UPI account, with no
    // manual refresh.
    const channel = supabase
      .channel('dashboard-applications')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'applications' }, () => {
        // v_allotment_board's own shared cache entry has a 15s staleTime
        // (RealtimeCacheSync, App.tsx, invalidates it independently on the
        // same event) — invalidating it here too, right before the
        // dashboard query, means THIS reload never races ahead of that on
        // timing. Redundant on many events, never harmful.
        queryClient.invalidateQueries({ queryKey: queryKeys.allotmentBoard })
        queryClient.invalidateQueries({ queryKey: dashboardQueryKey })
      })
      .subscribe()

    // The realtime subscription above only fires on a DB write — it has no
    // way to know a live share price moved on its own, so "Expected
    // profit"/"Parent: ..." would otherwise only ever update on the next
    // manual page load. A 5-minute poll keeps those numbers actually live
    // while the tab's open, without hammering the underlying quote API
    // (fetch-stock-price's own 15-minute cache absorbs the rest).
    const priceRefreshInterval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: dashboardQueryKey })
    }, 5 * 60 * 1000)

    return () => {
      supabase.removeChannel(channel)
      clearInterval(priceRefreshInterval)
    }
  }, [isAdmin, profile?.id, queryClient, dashboardQueryKey])

  // One batched call for every distinct parent-company symbol currently in
  // view, not one call per card — mirrors IposPage's admin-side equivalent.
  useEffect(() => {
    const symbols = Array.from(
      new Set((data?.ipoProgress ?? []).map((p) => p.parentCompanySymbol).filter((s): s is string => !!s)),
    )
    if (symbols.length === 0) return
    supabase.functions
      .invoke<{ prices?: Record<string, { price: number | null; stale: boolean }> }>('fetch-stock-price', {
        body: { symbols },
      })
      .then(({ data: priceData }) => {
        if (priceData?.prices) setParentPrices((prev) => ({ ...prev, ...priceData.prices }))
      })
  }, [data?.ipoProgress])

  if (loading || !data) return <DashboardSkeleton />

  // Attribution is computed from a separately-scoped set of rows (top-8
  // most-recently-opened IPOs — see topRecentIpoAttributionRows) than
  // ipoProgress (every currently-live IPO with at least one application),
  // so the two lists don't always cover exactly the same IPOs. Looked up
  // per card rather than assumed present — IpoDashboardCard already treats
  // a missing attribution as "no donut for this one" (still renders the
  // progress ring), not an error.
  const attributionByIpoId = new Map(data.attribution.map((a) => [a.ipoId, a]))

  // Same per-IPO blocks expectedProfitByIpo already built, filtered down to
  // just the still-projected (non-booked) lines so this tile's drill-down
  // panel actually sums to its own headline number instead of silently
  // mixing in already-SOLD lines too.
  const unrealizedProfitByIpo = data.expectedProfitByIpo
    .map((b) => ({ ...b, funders: b.funders.filter((f) => !f.booked) }))
    .filter((b) => b.funders.length > 0)

  // Soonest listing first — nulls (no listing date yet) sort last, same
  // ordering as the hover panel above so the two never disagree.
  const sortedAllottedNotSold = [...data.allottedNotSold].sort((a, b) => {
    if (!a.listing_date && !b.listing_date) return 0
    if (!a.listing_date) return 1
    if (!b.listing_date) return -1
    return a.listing_date.localeCompare(b.listing_date)
  })

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            Dashboard
          </h1>
          {/* Quick jumps — full IPO list, and (admin only, same gate the
              sidebar nav uses) Payouts, which used to sit as its own icon on
              the Allotment board before moving here per feedback. */}
          <div className="flex items-center gap-1">
            <Link
              to="/ipos"
              aria-label="Go to IPOs"
              title="Go to IPOs"
              className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--hover-surface)]"
              style={{ color: 'var(--ink-muted)' }}
            >
              <GraphIcon size={16} />
            </Link>
            {isAdmin && (
              <Link
                to="/payouts"
                aria-label="Go to Payouts"
                title="Go to Payouts"
                className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--hover-surface)]"
                style={{ color: 'var(--ink-muted)' }}
              >
                <IndianRupee size={16} />
              </Link>
            )}
          </div>
        </div>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          {isAdmin ? 'Overview across all accounts and IPOs' : 'Overview of your accounts and upcoming IPOs'}
        </p>
      </div>

      {/* Sized down (smaller padding/icon/text in StatTile itself) so all
          6 tiles fit in one row instead of wrapping to a second. Both
          roles get 6 now — "Owed to you"/"Expected profit" used to be
          admin-only (4 tiles for a funder), but they're RLS-scoped to the
          viewer's own data either way, so a funder gets the same count. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {/* Every application whose mandate isn't CANCELLED — a cancelled
            one never actually had money move, so it's not really "applied"
            in any sense worth counting (same reasoning as the accounts-left
            fix and the Settings cancelled-mandates section). */}
        <StatTile icon={FileIcon} label="IPOs applied" value={data.totalApplied} tone="info" to="/applications" />
        {/* Exact close_date === today, not a 7-day window — see load()'s
            closingToday query. Bidding actually cuts off at 4:50 PM on the
            close date, not midnight — surfaced in the hover panel so
            "closing today" reads as "still time until 4:50 PM," not
            "already over." */}
        <StatTile
          icon={ClockIcon}
          label="Closing today"
          value={data.closingToday.length}
          tone="info"
          to="/ipos"
          panel={<ClosingTodayPanel ipos={data.closingToday} />}
        />
        <StatTile
          icon={LawIcon}
          label="Awaiting mandate approval"
          value={data.pendingMandate.length}
          tone="warning"
          to="/applications"
          panel={<PendingMandatePanel rows={data.pendingMandate} />}
        />
        <StatTile
          icon={CheckCircleIcon}
          label="Allotted, not sold"
          value={data.allottedNotSold.length}
          // Same tone as "Awaiting mandate approval" — both are "still
          // needs action" states, not a settled/good one.
          tone="warning"
          to="/allotment"
          panel={<AllottedNotSoldPanel rows={data.allottedNotSold} />}
        />
        {isAdmin ? (
          <StatTile
            icon={CreditCardIcon}
            label="Payouts pending"
            value={data.pendingPayouts.reduce((sum, p) => sum + p.amount, 0)}
            tone="good"
            format={(n) => `₹${n.toLocaleString('en-IN')}`}
            // Where the money's owed actually gets marked paid.
            to="/payouts"
            panel={<PendingPayoutsPanel payouts={data.pendingPayouts} showExpectedNote />}
          />
        ) : (
          // Funder-facing mirror of the tile above — same underlying data
          // (already RLS-scoped to just their own funded/sold applications,
          // see pendingPayouts), just framed as "what's owed to me" instead
          // of admin's "what do I still need to pay out." No /payouts link
          // — that page's own ledger (settlement_payments) is genuinely
          // admin-only, not something a funder can drill into further.
          <StatTile
            icon={CreditCardIcon}
            label="Owed to you"
            value={data.pendingPayouts.reduce((sum, p) => sum + p.amount, 0)}
            tone="good"
            format={(n) => `₹${n.toLocaleString('en-IN')}`}
            panel={<PendingPayoutsPanel payouts={data.pendingPayouts} />}
          />
        )}
        {/* No longer admin-only — expectedProfitTotal/expectedProfitByIpo
            are now built from an RLS-scoped fetch (see load()), so a
            funder viewer already only ever sees their own applications'
            projection here, same as the tile above. Links to the same
            "Allotment updates" cards on Notifications, which show this
            same figure per-IPO for either role. */}
        <StatTile
          icon={GraphIcon}
          label="Expected profit"
          value={data.expectedProfitTotal}
          tone="good"
          format={(n) => `₹${n.toLocaleString('en-IN')}`}
          to="/notifications"
          panel={<ExpectedProfitPanel blocks={unrealizedProfitByIpo} />}
        />
      </div>

      {data.ipoProgress.length > 0 && (
        <section>
          <h2 className="section-heading mb-3 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            IPOs
          </h2>
          {/* One card per row, stacked — not a multi-column grid. Each card
              already carries a lot (header + donut+legend + ring side by
              side + its own expand panel); wrapping several of those into
              columns left the donut/legend pair cramped for width. Full
              width per card gives the pie chart and progress ring room to
              sit adjacent to each other without competing with a neighbor
              column for space. */}
          <div className="space-y-4">
            {data.ipoProgress.map((p) => (
              <IpoDashboardCard
                key={p.ipoId}
                companyName={p.companyName}
                openDate={p.openDate}
                closeDate={p.closeDate}
                allotmentDate={p.allotmentDate}
                listingDate={p.listingDate}
                gmpNotes={p.gmpNotes}
                subscriptionRate={p.subscriptionRate}
                applied={p.applied}
                totalActive={p.totalActive}
                remainingHolderNames={p.remainingHolderNames}
                attribution={attributionByIpoId.get(p.ipoId)}
                expanded={expandedIpoIds.has(p.ipoId)}
                onToggleExpanded={() => toggleExpanded(p.ipoId)}
                allottedCount={p.allottedCount}
                ipoId={p.ipoId}
                shareholderIssueSize={p.shareholderIssueSize}
                parentCompanyName={p.parentCompanyName}
                parentPrice={p.parentCompanySymbol ? parentPrices[p.parentCompanySymbol] : undefined}
              />
            ))}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* "IPOs closing today" list dropped from here — the top KPI tile
            already covers this (with its own hover panel listing the same
            IPOs), a duplicate list further down the page was redundant. */}
        <Section title="Applications awaiting mandate approval" empty="None pending" scrollAfter={6}>
          {data.pendingMandate.map((r) => (
            <Row
              key={r.application_id}
              initial={r.holder_name[0]}
              tone="warning"
              to={`/applications#mandate-${r.application_id}`}
            >
              <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                {r.holder_name}
              </span>
              <span style={{ color: 'var(--ink-muted)' }}>{r.company_name}</span>
            </Row>
          ))}
        </Section>

        <Section title="Allotted, not yet sold" empty="Nothing outstanding">
          {sortedAllottedNotSold.map((r) => (
            <Row key={r.application_id} initial={r.holder_name[0]} tone="warning" to="/allotment">
              <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                {r.holder_name}
              </span>
              <span style={{ color: 'var(--ink-muted)' }}>
                {r.company_name} · listing {r.listing_date ? formatOrdinalDate(r.listing_date) : '—'}
              </span>
            </Row>
          ))}
        </Section>

        {isAdmin && (
          <Section title="Payouts pending" empty="Nothing owed right now">
            {data.pendingPayouts.map((p) => (
              <div key={p.name} className="row-card stagger-item flex items-center gap-3 p-4 text-sm">
                <div
                  className="icon-badge icon-badge-good shrink-0 text-xs font-semibold"
                  style={{ width: '2rem', height: '2rem' }}
                >
                  {p.name[0]?.toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                    <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {p.name}
                    </span>
                    <span style={{ color: 'var(--good)' }}>₹{Math.round(p.amount).toLocaleString('en-IN')}</span>
                  </div>
                  <div className="mt-1 space-y-1">
                    {p.lines.map((l) => (
                      <div
                        key={l.applicationId}
                        className="flex items-center justify-between gap-2 text-xs"
                        style={{ color: 'var(--ink-muted)' }}
                      >
                        <span>
                          {l.ipoName} · ₹{Math.round(l.amount).toLocaleString('en-IN')}
                        </span>
                        <button
                          onClick={() => markPayoutPaid(l)}
                          disabled={markingPaid === l.applicationId}
                          className="link-accent font-medium disabled:opacity-50"
                        >
                          {markingPaid === l.applicationId ? 'Marking…' : 'Mark paid'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
            {data.overpaidToFunders.length > 0 && (
              <div className="row-card p-4 text-sm">
                <p className="mb-1.5 text-xs font-medium tracking-wide uppercase" style={{ color: 'var(--ink-muted)' }}>
                  Overpaid
                </p>
                {data.overpaidToFunders.flatMap((p) =>
                  p.lines.map((l) => (
                    <div key={l.applicationId} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate" style={{ color: 'var(--ink-primary)' }}>
                        {p.name} - {l.ipoName.split(' ')[0]}
                      </span>
                      <span className="shrink-0 font-mono-ipo font-medium" style={{ color: 'var(--warning-text)' }}>
                        −₹{Math.round(l.amount).toLocaleString('en-IN')}
                      </span>
                    </div>
                  )),
                )}
              </div>
            )}
          </Section>
        )}
      </div>
    </div>
  )
}

export function StatTile({
  icon: Icon,
  label,
  value,
  tone = 'info',
  format,
  to,
  panel,
}: {
  icon: typeof ClockIcon
  label: string
  value: number
  tone?: 'info' | 'warning' | 'good' | 'critical'
  format?: (n: number) => string
  // Turns the tile into a link (e.g. "Awaiting mandate approval" ->
  // Applications) instead of a dead-end number — someone reading a count
  // that says action is needed shouldn't have to go hunt for where to act
  // on it.
  to?: string
  // Rich hover panel (HoverCard below) — a real styled card with its own
  // rows, not a plain-text browser tooltip. Optional: tiles with nothing
  // worth breaking down (IPOs applied, Awaiting mandate approval) skip it.
  panel?: ReactNode
}) {
  const toneColor = {
    info: 'var(--accent)',
    warning: 'var(--warning)',
    good: 'var(--good)',
    critical: 'var(--critical)',
  }[tone]
  // --shadow-glow-* is `none` in light mode, a real soft glow in dark
  // (KOVAREX retheme) — same class, no per-theme branching here.
  const toneGlow = {
    info: 'var(--shadow-glow-accent)',
    warning: 'var(--shadow-glow-warning)',
    good: 'var(--shadow-glow-primary)',
    critical: 'var(--shadow-glow-critical)',
  }[tone]
  const animated = useCountUp(value)
  // Icon + label share one row (was icon, then label, then value stacked
  // three-high) — the icon badge doesn't need a whole row to itself when
  // the label text next to it is exactly as short. One fewer row means the
  // tile itself can run shorter too (p-3 -> p-2.5 below), not just the same
  // height with a gap removed.
  const inner = (
    <>
      <div className="mb-1 flex items-center gap-1.5">
        <div
          className={`icon-badge icon-badge-${tone} shrink-0`}
          style={{ width: '1.5rem', height: '1.5rem', borderRadius: '0.4rem', boxShadow: toneGlow }}
        >
          <Icon size={12} />
        </div>
        <p className="min-w-0 truncate text-[11px]" style={{ color: 'var(--ink-muted)' }}>
          {label}
        </p>
      </div>
      <p
        className="font-mono-ipo truncate text-xl font-bold tracking-tight"
        style={{ color: value > 0 ? toneColor : 'var(--ink-primary)', fontVariantNumeric: 'tabular-nums' }}
      >
        {format ? format(animated) : animated}
      </p>
    </>
  )

  const tile = to ? (
    <Link to={to} className="glass-card tile-hover stagger-item flex flex-col p-2.5">
      {inner}
    </Link>
  ) : (
    <div className="glass-card tile-hover stagger-item flex flex-col p-2.5">{inner}</div>
  )

  if (!panel) return tile
  return (
    <HoverCard tone={tone} align="right" panel={panel}>
      {tile}
    </HoverCard>
  )
}

function ClosingTodayPanel({ ipos }: { ipos: Ipo[] }) {
  if (ipos.length === 0) return <PanelEmpty>Nothing closing today.</PanelEmpty>
  return (
    <div className="space-y-1.5">
      {ipos.map((ipo) => (
        <div key={ipo.id} className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
            {ipo.company_name}
          </span>
          {/* Bidding cuts off at 4:50 PM on the close date, not midnight —
              worth saying explicitly so "closing today" reads as "still
              time left," not "already over." */}
          <span className="shrink-0" style={{ color: 'var(--ink-muted)' }}>
            closes 4:50 PM
          </span>
        </div>
      ))}
    </div>
  )
}

// "17th Aug", not the raw "2026-08-17" — every other date-facing spot in
// this app (WhatsApp messages, IpoDashboardCard) already reads this way;
// the panel's plain ISO string was the odd one out.
// "20 Aug" — day + short month, no ordinal suffix. Same shape as
// AllotmentBoardPage's own formatShortDate (kept as a separate local copy
// rather than a cross-page import for one three-line function) — used
// where a compact panel needs a date without formatOrdinalDate's extra
// "th"/"nd"/"rd" width.
function formatShortDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const day = d.getUTCDate()
  const month = d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })
  return `${day} ${month}`
}

function formatOrdinalDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const day = d.getUTCDate()
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th'
  const month = d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })
  return `${day}${suffix} ${month}`
}

// Compact by request — this used to show the FULL company name plus
// "closes <ordinal date>, 4:50 PM," which for a long name (e.g. "Lalithaa
// Jewellery Mart") was also the panel HoverCard.tsx warns about: a
// shrink-0+truncate right column that's wider than the panel itself just
// clips mid-word ("...ellery Mart") instead of reading as anything. First
// word only (company_name.split(' ')[0], the same convention
// AllotmentBoardPage's own compact summary line already uses) plus a
// terser date — no "closes"/comma, no ordinal suffix — fixes both the
// truncation bug and the length at once.
function PendingMandatePanel({ rows }: { rows: AllotmentBoardRow[] }) {
  if (rows.length === 0) return <PanelEmpty>Nothing awaiting approval right now.</PanelEmpty>
  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        // Same "via <funder>" convention AllotmentBoardPage's own row uses
        // — only shown when there's actually a separate funder to name
        // (self-funded rows have bank_account_holder_name null or equal to
        // the holder's own name, and don't need "via themselves").
        const funderDiffers = r.bank_account_holder_name && !namesMatch(r.bank_account_holder_name, r.holder_name)
        return (
          <div key={r.application_id} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
              {r.holder_name}
              {funderDiffers && (
                <span className="font-normal" style={{ color: 'var(--ink-muted)' }}>
                  {' '}
                  · via {r.bank_account_holder_name}
                </span>
              )}
            </span>
            {/* IPO first name + close date only, no time — by request; the
                4:50 PM cutoff itself is unchanged everywhere else (the
                mandate-cutoff toast, isOpenForBidding, etc.), just not
                repeated on every row of this specific panel. */}
            <span className="min-w-0 shrink-0 truncate text-right" style={{ color: 'var(--ink-muted)' }}>
              {r.company_name.split(' ')[0]} · {formatShortDate(r.close_date)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function AllottedNotSoldPanel({ rows }: { rows: AllotmentBoardRow[] }) {
  if (rows.length === 0) return <PanelEmpty>Nothing outstanding.</PanelEmpty>
  // Soonest listing first — nulls (no listing date yet) sort last, not
  // first, since those aren't the ones anyone needs to act on soon.
  const sorted = [...rows].sort((a, b) => {
    if (!a.listing_date && !b.listing_date) return 0
    if (!a.listing_date) return 1
    if (!b.listing_date) return -1
    return a.listing_date.localeCompare(b.listing_date)
  })
  return (
    <div className="space-y-1.5">
      {sorted.map((r) => (
        <div key={r.application_id} className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
            {r.holder_name}
          </span>
          <span className="shrink-0 truncate text-right" style={{ color: 'var(--ink-muted)' }}>
            {r.company_name} · {r.listing_date ? formatOrdinalDate(r.listing_date) : 'no listing date yet'}
          </span>
        </div>
      ))}
    </div>
  )
}

function PendingPayoutsPanel({
  payouts,
  showExpectedNote,
}: {
  payouts: PendingPayout[]
  // Admin-tile-only — points at Payouts' own "Expected — not yet sold"
  // section (allotted applications with a live-price/GMP projection),
  // since this panel only ever lists CONFIRMED sold-application amounts
  // and there was previously no hint that a funder still worth preparing
  // to pay might not show up here yet just because it hasn't sold.
  showExpectedNote?: boolean
}) {
  if (payouts.length === 0) return <PanelEmpty>Nothing owed right now.</PanelEmpty>
  return (
    <div className="space-y-1.5">
      {payouts.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
            {p.name}
          </span>
          <span className="shrink-0" style={{ color: 'var(--good)' }}>
            {rupees(p.amount)}
          </span>
        </div>
      ))}
      {showExpectedNote && (
        <p className="border-t pt-1.5 text-[11px]" style={{ borderColor: 'var(--border)', color: 'var(--ink-muted)' }}>
          Confirmed (sold) amounts only — see Payouts' "Expected — not yet sold" section for allotted applications
          still awaiting a sale.
        </p>
      )}
    </div>
  )
}

function ExpectedProfitPanel({ blocks }: { blocks: ExpectedProfitIpoBlock[] }) {
  if (blocks.length === 0) return <PanelEmpty>No allotted applications with a price band on file yet.</PanelEmpty>
  return (
    <div className="space-y-2.5">
      {blocks.map((b) => (
        <div key={b.ipoName}>
          <p className="mb-1 truncate font-semibold" style={{ color: 'var(--ink-primary)' }}>
            {b.ipoName}
            {b.priceSource === 'live' && b.livePricePerShare != null && (
              <span className="ml-2 text-[10px] font-normal" style={{ color: 'var(--accent)' }}>
                live @ ₹{b.livePricePerShare}/share
              </span>
            )}
            {b.needsSymbolForLivePrice && (
              <Link
                to="/ipos"
                title="Already listed with no symbol on file — add one for a live price"
                aria-label="Add this IPO's symbol for a live price"
                className="link-accent ml-1.5 inline-flex align-middle"
              >
                <LinkIcon size={11} />
              </Link>
            )}
          </p>
          <div className="space-y-1">
            {b.funders.map((f, i) => (
              <div key={i} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate" style={{ color: 'var(--ink-secondary)' }}>
                  <span style={{ color: 'var(--ink-muted)' }}>{f.funderName}:</span> {f.holderNames}
                  {f.booked && (
                    <span className="ml-1.5 text-[10px] font-medium" style={{ color: 'var(--ink-muted)' }}>
                      (booked)
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-medium" style={{ color: 'var(--good)' }}>
                    {rupees(f.profit)}
                  </span>
                  {/* Invested + profit — the actual figure to hand back,
                      not just the profit slice above it. Booked lines have
                      nothing left to project-and-return — the sale's done. */}
                  {f.amountToReturn != null && (
                    <span className="block text-[10px]" style={{ color: 'var(--ink-muted)' }}>
                      return {rupees(f.amountToReturn)}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
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

function Section({
  title,
  empty,
  children,
  scrollAfter,
}: {
  title: string
  empty: string
  children: ReactNode
  /** Once there are more rows than this, cap the list's height and let it
   *  scroll internally instead of growing the card indefinitely. Below the
   *  threshold, height is untouched — no scrollbar for a short list. */
  scrollAfter?: number
}) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : []
  const hasChildren = items.length > 0
  const shouldScroll = scrollAfter != null && items.length > scrollAfter
  return (
    <section>
      <h2 className="section-heading mb-3 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
        {title}
      </h2>
      {hasChildren ? (
        // Individual glass row-cards (Dashboard.dc.html reference), not rows
        // inside one bordered list — each item is its own card with its own
        // hover lift. Past scrollAfter, cap height and scroll the stack
        // instead of the card growing indefinitely; a little right padding
        // keeps the scrollbar from overlapping the cards' own edge.
        <div
          className={`flex flex-col gap-3 ${shouldScroll ? 'overflow-y-auto pr-1' : ''}`}
          style={{ maxHeight: shouldScroll ? '18rem' : undefined }}
        >
          {children}
        </div>
      ) : (
        <p className="glass-card p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
          {empty}
        </p>
      )}
    </section>
  )
}

function Row({
  children,
  initial,
  tone = 'info',
  to,
}: {
  children: ReactNode
  initial: string
  tone?: 'info' | 'warning' | 'good' | 'critical'
  // e.g. the "awaiting mandate approval" list -> the specific application
  // on the Applications page, where it can actually be marked, instead of
  // a dead-end row that just describes the problem.
  to?: string
}) {
  const inner = (
    <>
      <div
        className={`icon-badge icon-badge-${tone} shrink-0 text-xs font-semibold`}
        style={{ width: '2rem', height: '2rem' }}
      >
        {initial.toUpperCase()}
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-0.5">{children}</div>
    </>
  )
  if (to) {
    return (
      <Link to={to} className="row-card stagger-item flex items-center gap-3 p-4 text-sm">
        {inner}
      </Link>
    )
  }
  return <div className="row-card stagger-item flex items-center gap-3 p-4 text-sm">{inner}</div>
}

function DashboardSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="glass-card space-y-2.5 p-3">
            <Skeleton className="h-8 w-8" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-8 w-14" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card space-y-3 p-4">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3.5 w-full rounded-full" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
              {Array.from({ length: 3 }).map((_, j) => (
                <div key={j} className="flex items-center justify-between px-4 py-2.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-20" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
