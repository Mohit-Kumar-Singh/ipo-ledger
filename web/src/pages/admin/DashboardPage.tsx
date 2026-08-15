import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircleIcon, ClockIcon, LawIcon, CreditCardIcon, FileIcon, GraphIcon } from '@primer/octicons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Skeleton } from '../../components/PageSpinner'
import { IpoDashboardCard } from '../../components/IpoDashboardCard'
import { HoverCard } from '../../components/HoverCard'
import { bidCutoffMs, isLiveIpo, nowIst } from '../../lib/ipoStatus'
import { parseGmpPercent } from '../../lib/ipoGmp'
import { showToast } from '../../lib/toast'
import { computeProfitSplit } from '../../lib/profitSplit'
import { computeIpoAttribution, sameIdentity, type IpoAttribution } from '../../lib/applicationAttribution'
import { resolveAttributionNames, topRecentIpoAttributionRows } from '../../lib/dashboardAttribution'
import {
  buildFunderAllottedCards,
  expectedProfitBreakdown,
  rupees,
  type FunderAllottedCard,
  type ProfitProjectionRow,
} from '../../lib/expectedProfit'
import { useCountUp } from '../../lib/useCountUp'
import type {
  AllotmentBoardRow,
  ApplicationAttributionRow,
  DematAccount,
  Ipo,
} from '../../types/database'

interface PendingPayoutLine {
  applicationId: string
  field: 'demat_cut_paid' | 'funder_share_paid'
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
  // secondary line under the profit amount.
  amountToReturn: number
}
interface ExpectedProfitIpoBlock {
  ipoName: string
  funders: ExpectedProfitFunderLine[]
}

interface DashboardData {
  closingToday: Ipo[]
  pendingMandate: AllotmentBoardRow[]
  allottedNotSold: AllotmentBoardRow[]
  attribution: IpoAttribution[]
  ipoProgress: IpoProgress[]
  highGmpAlerts: HighGmpAlert[]
  pendingPayouts: PendingPayout[]
  totalApplied: number
  // Sum of projected net profit (your half, after the demat holder's cut)
  // across every currently-allotted-or-sold application with a price band
  // on file — same per-lot math as NotificationsPage's funder "Allotment
  // updates" cards (buildFunderAllottedCards/expectedProfitBreakdown,
  // shared via lib/expectedProfit.ts so the two numbers can't drift apart).
  expectedProfitTotal: number
  expectedProfitByIpo: ExpectedProfitIpoBlock[]
}

// Sums, per recipient, everything you still owe out of already-sold
// applications — the demat holder's cut when they aren't you, and the
// funder's 50/50 share when the split is on and they aren't you either.
function buildPendingPayouts(soldRows: AllotmentBoardRow[], profitPersonName: string): PendingPayout[] {
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
      cutPercent: r.profit_share_percent,
      dematHolderName: r.holder_name,
      funderName: r.bank_account_holder_name,
      profitPersonName,
      splitWithFunder: r.split_profit_with_funder,
    })
    if (!result.isDematHolderSelf && result.dematCutAmount > 0 && !r.demat_cut_paid) {
      add(r.holder_name, {
        applicationId: r.application_id,
        field: 'demat_cut_paid',
        ipoName: r.company_name,
        amount: result.dematCutAmount,
      })
    }
    if (result.funderShare > 0 && !r.funder_share_paid) {
      add(r.bank_account_holder_name ?? 'Unknown', {
        applicationId: r.application_id,
        field: 'funder_share_paid',
        ipoName: r.company_name,
        amount: result.funderShare,
      })
    }
  }
  return Array.from(byName.entries())
    .map(([name, lines]) => ({ name, amount: lines.reduce((s, l) => s + l.amount, 0), lines }))
    .sort((a, b) => b.amount - a.amount)
}

// One block per IPO, one line per funder within it — funder is always
// named, every time, no matter how many funder cards an IPO has. Confirmed
// bug in the earlier version: it only prefixed "from {funder}" when an IPO
// had MORE than one funder card, so a single-funder IPO's funder name
// (e.g. Dhoot funded by Avinash) silently vanished from the panel while a
// two-funder IPO right next to it showed both names fine.
function buildExpectedProfitByIpo(cards: FunderAllottedCard[]): ExpectedProfitIpoBlock[] {
  const byIpo = new Map<string, ExpectedProfitIpoBlock>()
  for (const c of cards) {
    if (!byIpo.has(c.ipoName)) byIpo.set(c.ipoName, { ipoName: c.ipoName, funders: [] })
    const b = expectedProfitBreakdown(c)
    byIpo.get(c.ipoName)!.funders.push({
      funderName: c.funderName,
      holderNames: c.holderNames.map((h) => h.name).join(', '),
      profit: b.netYourProfit,
      amountToReturn: b.amountToReturn,
    })
  }
  return Array.from(byIpo.values())
}

export function DashboardPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [markingPaid, setMarkingPaid] = useState<string | null>(null)
  // A Set, not a single "currently expanded" id — each IpoDashboardCard
  // owns its own expand state and several can be open across the grid at
  // once, independent of each other, not a single shared panel that only
  // one card at a time can claim.
  const [expandedIpoIds, setExpandedIpoIds] = useState<Set<string>>(new Set())
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

  async function markPayoutPaid(line: PendingPayoutLine) {
    setMarkingPaid(line.applicationId + line.field)
    await supabase.from('applications').update({ [line.field]: true }).eq('id', line.applicationId)
    setMarkingPaid(null)
    setData((d) => {
      if (!d) return d
      const pendingPayouts = d.pendingPayouts
        .map((p) => ({
          ...p,
          lines: p.lines.filter((l) => !(l.applicationId === line.applicationId && l.field === line.field)),
        }))
        .map((p) => ({ ...p, amount: p.lines.reduce((s, l) => s + l.amount, 0) }))
        .filter((p) => p.lines.length > 0)
      return { ...d, pendingPayouts }
    })
  }

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      // IST, not the device/browser/server's own local date — a plain
      // `new Date().toISOString().slice(0, 10)` reads UTC, which is still
      // "yesterday" for the first 5.5 hours of every IST day (00:00-05:29
      // IST = the previous UTC date). That's exactly what made an IPO that
      // actually closed the day before still show up under "closing today."
      const todayStr = nowIst().dateStr

      // Link requests moved off the Dashboard entirely (review now lives on
      // Profile, with a toast on arrival instead of a permanent tile/list
      // here — see ToastHost) — no longer fetched on this page at all.
      const [closingToday, allIpos, activeAccounts, board, attributionRes, profitRows] = await Promise.all([
        // Exact close_date match, not a 7-day window — "closing today" is
        // the thing that actually needs same-day action; a 7-day-out IPO
        // isn't urgent yet and just crowded out the tile/list with noise.
        supabase.from('ipos').select('*').eq('close_date', todayStr).order('company_name'),
        supabase.from('ipos').select('*'),
        supabase.from('demat_accounts').select('id, holder_name').eq('is_active', true),
        supabase.from('v_allotment_board').select('*'),
        supabase.from('v_application_attribution').select('*'),
        // Same row shape/query NotificationsPage's admin-only funder query
        // uses (see lib/expectedProfit.ts's ProfitProjectionRow) — admin
        // only, same reasoning as pendingPayouts below (funder/profit-split
        // data across every account, not just the viewer's own).
        isAdmin
          ? supabase
              .from('applications')
              .select(
                'ipo_id, lots, applied_at, status, mandate_status, ipoji_status_text, ' +
                  'ipos(company_name, open_date, close_date, listing_date, price_high, lot_size, gmp_notes, is_archived), ' +
                  'demat_accounts(holder_name, profit_share_percent, phone_e164), ' +
                  'bank_accounts!bank_account_id(account_holder_name, phone_e164, upi_id), ' +
                  'funder_override:bank_accounts!funder_override_id(account_holder_name, phone_e164, upi_id)',
              )
              .in('status', ['ALLOTTED', 'SOLD'])
              .or('bank_account_id.not.is.null,funder_override_id.not.is.null')
          : Promise.resolve({ data: [], error: null }),
      ])

      if (cancelled) return

      // Top 8 most-recently-opened IPOs (Profile mirrors the top 4 of this
      // same ordering) — resolving names is a second round trip since it
      // depends on which ids show up in that scoped set.
      const scopedRows = topRecentIpoAttributionRows((attributionRes.data ?? []) as ApplicationAttributionRow[], 8)
      const nameById = await resolveAttributionNames(scopedRows)
      if (cancelled) return

      // Archived IPOs (settled + moved to /archives) shouldn't keep showing
      // up in "Awaiting mandate approval," "Allotted, not sold," or
      // "Payouts pending" — those tiles are for what's still live, not a
      // running history of everything that ever happened.
      const boardRows = ((board.data ?? []) as AllotmentBoardRow[]).filter((r) => !r.ipo_is_archived)

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
      const activeDematAccounts = (activeAccounts.data ?? []) as Pick<DematAccount, 'id' | 'holder_name'>[]
      const totalActive = activeDematAccounts.length
      const ipoProgress: IpoProgress[] = ((allIpos.data ?? []) as Ipo[])
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
          }
        })
        // No point showing a progress tile for an IPO nobody has applied to
        // yet — it's not "in progress," there's nothing to track.
        .filter((p) => p.applied > 0)
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
      const highGmpAlerts: HighGmpAlert[] = ((allIpos.data ?? []) as Ipo[])
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

      // Skip archived IPOs (fully settled — not worth projecting profit on
      // anymore) and cards with no price band on file (same guard the
      // WhatsApp message itself uses — nothing sane to project without one).
      const profitCards = buildFunderAllottedCards(
        ((profitRows.data ?? []) as unknown as ProfitProjectionRow[]).filter((r) => !r.ipos?.is_archived),
        sameIdentity,
      ).filter((c) => c.priceHigh)
      const expectedProfitTotal = profitCards.reduce(
        (sum, c) => sum + expectedProfitBreakdown(c).netYourProfit,
        0,
      )
      const expectedProfitByIpo = buildExpectedProfitByIpo(profitCards)

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

      setData({
        closingToday: (closingToday.data ?? []) as Ipo[],
        pendingMandate: actionablePendingMandate,
        allottedNotSold: boardRows.filter((r) => r.status === 'ALLOTTED'),
        attribution: computeIpoAttribution(scopedRows, nameById).sort((a, b) => b.openDate.localeCompare(a.openDate)),
        ipoProgress,
        highGmpAlerts,
        expectedProfitTotal,
        expectedProfitByIpo,
        pendingPayouts: isAdmin
          ? buildPendingPayouts(boardRows.filter((r) => r.status === 'SOLD'), profile?.full_name ?? '')
          : [],
        // A CANCELLED mandate means the funder never actually approved the
        // UPI block — no money moved, so it's not really "applied" in any
        // sense worth counting here (same reasoning as the accounts-left
        // fix above). boardRows is already RLS-scoped per viewer (every
        // account for admin, just this member's own for a member), so this
        // reads as "how many IPOs has admin/this member applied to" either
        // way, matching the section's own "across all accounts"/"your
        // accounts" framing.
        totalApplied: boardRows.filter((r) => r.mandate_status !== 'CANCELLED').length,
      })
      setLoading(false)
    }
    load()

    // Live-refresh whenever an application changes — e.g. a member's
    // dashboard should reflect the instant an admin creates/edits an
    // application funded by that member's linked bank/UPI account, with no
    // manual refresh.
    const channel = supabase
      .channel('dashboard-applications')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'applications' }, () => {
        if (!cancelled) load()
      })
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
    // isAdmin is captured by load() for pendingPayouts — now that
    // ProtectedRoute no longer blocks rendering until the profile row has
    // loaded (see AuthContext), isAdmin can still be false on the very
    // first run of this effect for an actual admin whose profile hasn't
    // arrived yet. Re-running once it flips to true avoids Payouts pending
    // getting stuck empty until a manual refresh.
  }, [isAdmin])

  if (loading || !data) return <DashboardSkeleton />

  // Attribution is computed from a separately-scoped set of rows (top-8
  // most-recently-opened IPOs — see topRecentIpoAttributionRows) than
  // ipoProgress (every currently-live IPO with at least one application),
  // so the two lists don't always cover exactly the same IPOs. Looked up
  // per card rather than assumed present — IpoDashboardCard already treats
  // a missing attribution as "no donut for this one" (still renders the
  // progress ring), not an error.
  const attributionByIpoId = new Map(data.attribution.map((a) => [a.ipoId, a]))

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
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Dashboard
        </h1>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          {isAdmin ? 'Overview across all accounts and IPOs' : 'Overview of your accounts and upcoming IPOs'}
        </p>
      </div>

      {/* Sized down (smaller padding/icon/text in StatTile itself) so all of
          them fit in one row instead of wrapping to a second — a fixed
          3-col grid wrapped 6 admin tiles to two rows; this scales the
          column count to however many tiles actually render for the
          viewer's role instead. */}
      <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 ${isAdmin ? 'lg:grid-cols-6' : 'lg:grid-cols-4'}`}>
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
        {isAdmin && (
          <StatTile
            icon={CreditCardIcon}
            label="Payouts pending"
            value={data.pendingPayouts.reduce((sum, p) => sum + p.amount, 0)}
            tone="good"
            format={(n) => `₹${n.toLocaleString('en-IN')}`}
            // Where the money's owed actually gets marked paid — Applications
            // has no payout UI at all, that's Allotment board's job.
            to="/allotment"
            panel={<PendingPayoutsPanel payouts={data.pendingPayouts} />}
          />
        )}
        {isAdmin && (
          <StatTile
            icon={GraphIcon}
            label="Expected profit"
            value={data.expectedProfitTotal}
            tone="good"
            format={(n) => `₹${n.toLocaleString('en-IN')}`}
            to="/notifications"
            panel={<ExpectedProfitPanel blocks={data.expectedProfitByIpo} />}
          />
        )}
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
          <div className="space-y-3">
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
                        key={l.applicationId + l.field}
                        className="flex items-center justify-between gap-2 text-xs"
                        style={{ color: 'var(--ink-muted)' }}
                      >
                        <span>
                          {l.ipoName} · ₹{Math.round(l.amount).toLocaleString('en-IN')}
                        </span>
                        <button
                          onClick={() => markPayoutPaid(l)}
                          disabled={markingPaid === l.applicationId + l.field}
                          className="link-accent font-medium disabled:opacity-50"
                        >
                          {markingPaid === l.applicationId + l.field ? 'Marking…' : 'Mark paid'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </Section>
        )}
      </div>
    </div>
  )
}

function StatTile({
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
  const inner = (
    <>
      <div
        className={`icon-badge icon-badge-${tone} mb-2.5`}
        style={{ width: '2rem', height: '2rem', borderRadius: '0.5rem', boxShadow: toneGlow }}
      >
        <Icon size={15} />
      </div>
      <p className="mb-1 truncate text-[11px]" style={{ color: 'var(--ink-muted)' }}>
        {label}
      </p>
      <p
        className="font-mono-ipo truncate text-xl font-bold tracking-tight"
        style={{ color: value > 0 ? toneColor : 'var(--ink-primary)', fontVariantNumeric: 'tabular-nums' }}
      >
        {format ? format(animated) : animated}
      </p>
    </>
  )

  const tile = to ? (
    <Link to={to} className="glass-card tile-hover stagger-item flex flex-col p-3">
      {inner}
    </Link>
  ) : (
    <div className="glass-card tile-hover stagger-item flex flex-col p-3">{inner}</div>
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
function formatOrdinalDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const day = d.getUTCDate()
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th'
  const month = d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })
  return `${day}${suffix} ${month}`
}

function PendingMandatePanel({ rows }: { rows: AllotmentBoardRow[] }) {
  if (rows.length === 0) return <PanelEmpty>Nothing awaiting approval right now.</PanelEmpty>
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.application_id} className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
            {r.holder_name}
          </span>
          <span className="shrink-0 truncate text-right" style={{ color: 'var(--ink-muted)' }}>
            {r.company_name} · closes {formatOrdinalDate(r.close_date)}, 4:50 PM
          </span>
        </div>
      ))}
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

function PendingPayoutsPanel({ payouts }: { payouts: PendingPayout[] }) {
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
          </p>
          <div className="space-y-1">
            {b.funders.map((f, i) => (
              <div key={i} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate" style={{ color: 'var(--ink-secondary)' }}>
                  <span style={{ color: 'var(--ink-muted)' }}>{f.funderName}:</span> {f.holderNames}
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-medium" style={{ color: 'var(--good)' }}>
                    {rupees(f.profit)}
                  </span>
                  {/* Invested + profit — the actual figure to hand back,
                      not just the profit slice above it. */}
                  <span className="block text-[10px]" style={{ color: 'var(--ink-muted)' }}>
                    return {rupees(f.amountToReturn)}
                  </span>
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
