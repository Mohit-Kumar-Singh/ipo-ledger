import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertIcon, CheckCircleIcon, ClockIcon, LawIcon, CreditCardIcon } from '@primer/octicons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Skeleton } from '../../components/PageSpinner'
import { IpoDashboardCard } from '../../components/IpoDashboardCard'
import { isLiveIpo } from '../../lib/ipoStatus'
import { parseGmpPercent } from '../../lib/ipoGmp'
import { showToast } from '../../lib/toast'
import { computeProfitSplit } from '../../lib/profitSplit'
import { computeIpoAttribution, type IpoAttribution } from '../../lib/applicationAttribution'
import { resolveAttributionNames, topRecentIpoAttributionRows } from '../../lib/dashboardAttribution'
import { useCountUp } from '../../lib/useCountUp'
import type {
  AllotmentBoardRow,
  ApplicationAttributionRow,
  DematAccount,
  Ipo,
  Notification,
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
}

const HIGH_GMP_THRESHOLD = 15

interface HighGmpAlert {
  ipoId: string
  companyName: string
  openDate: string
  gmpPercent: number
  gmpNotes: string
}

interface DashboardData {
  closingSoon: Ipo[]
  pendingMandate: AllotmentBoardRow[]
  allottedNotSold: AllotmentBoardRow[]
  failedMessages: Notification[]
  attribution: IpoAttribution[]
  ipoProgress: IpoProgress[]
  highGmpAlerts: HighGmpAlert[]
  pendingPayouts: PendingPayout[]
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
  const hasShownGmpToast = useRef(localStorage.getItem('gmpToastShownDate') === new Date().toISOString().slice(0, 10))

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
      const todayStr = new Date().toISOString().slice(0, 10)
      const in7d = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)

      // Link requests moved off the Dashboard entirely (review now lives on
      // Profile, with a toast on arrival instead of a permanent tile/list
      // here — see ToastHost) — no longer fetched on this page at all.
      const [closingSoon, allIpos, activeAccounts, board, failedMessages, attributionRes] = await Promise.all([
        supabase.from('ipos').select('*').gte('close_date', todayStr).lte('close_date', in7d).order('close_date'),
        supabase.from('ipos').select('*'),
        supabase.from('demat_accounts').select('id, holder_name').eq('is_active', true),
        supabase.from('v_allotment_board').select('*'),
        supabase
          .from('notifications')
          .select('*')
          .eq('status', 'FAILED')
          .order('created_at', { ascending: false })
          .limit(20),
        supabase.from('v_application_attribution').select('*'),
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
        if (!appliedDematIdsByIpo.has(r.ipo_id)) appliedDematIdsByIpo.set(r.ipo_id, new Set())
        appliedDematIdsByIpo.get(r.ipo_id)!.add(r.demat_id)
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
      const todayForGmp = new Date().toISOString().slice(0, 10)
      const in2DaysForGmp = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
      const highGmpAlerts: HighGmpAlert[] = ((allIpos.data ?? []) as Ipo[])
        .filter((ipo) => ipo.open_date >= todayForGmp && ipo.open_date <= in2DaysForGmp)
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

      setData({
        closingSoon: (closingSoon.data ?? []) as Ipo[],
        // Real mandate_status (0047/0048), not the previous proxy of "every
        // still-APPLIED application" — that counted plenty of applications
        // whose mandate was already approved and were just waiting on
        // allotment, nothing to do with mandate status at all.
        pendingMandate: boardRows.filter((r) => r.mandate_status === 'PENDING'),
        allottedNotSold: boardRows.filter((r) => r.status === 'ALLOTTED'),
        failedMessages: (failedMessages.data ?? []) as Notification[],
        attribution: computeIpoAttribution(scopedRows, nameById).sort((a, b) => b.openDate.localeCompare(a.openDate)),
        ipoProgress,
        highGmpAlerts,
        pendingPayouts: isAdmin
          ? buildPendingPayouts(boardRows.filter((r) => r.status === 'SOLD'), profile?.full_name ?? '')
          : [],
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
        <StatTile icon={ClockIcon} label="Closing within 7 days" value={data.closingSoon.length} tone="info" to="/ipos" />
        <StatTile
          icon={LawIcon}
          label="Awaiting mandate approval"
          value={data.pendingMandate.length}
          tone="warning"
          to="/applications"
        />
        <StatTile
          icon={CheckCircleIcon}
          label="Allotted, not sold"
          value={data.allottedNotSold.length}
          tone="good"
          to="/allotment"
        />
        <StatTile
          icon={AlertIcon}
          label="Failed messages"
          value={data.failedMessages.length}
          tone="critical"
          to="/notifications"
        />
        {isAdmin && (
          <StatTile
            icon={CreditCardIcon}
            label="Payouts pending"
            value={data.pendingPayouts.reduce((sum, p) => sum + p.amount, 0)}
            tone="warning"
            format={(n) => `₹${n.toLocaleString('en-IN')}`}
            to="/applications"
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
          <div className="space-y-5">
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
              />
            ))}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section title="IPOs closing within 7 days" empty="Nothing closing soon" scrollAfter={6}>
          {data.closingSoon.map((ipo) => (
            <Row key={ipo.id} initial={ipo.company_name[0]} tone="info" to="/ipos">
              <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                {ipo.company_name}
              </span>
              <span style={{ color: 'var(--ink-muted)' }}>closes {ipo.close_date}</span>
            </Row>
          ))}
        </Section>

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
          {data.allottedNotSold.map((r) => (
            <Row key={r.application_id} initial={r.holder_name[0]} tone="good" to="/allotment">
              <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                {r.holder_name}
              </span>
              <span style={{ color: 'var(--ink-muted)' }}>
                {r.company_name} · listing {r.listing_date ?? '—'}
              </span>
            </Row>
          ))}
        </Section>

        {isAdmin && (
          <Section title="Payouts pending" empty="Nothing owed right now">
            {data.pendingPayouts.map((p) => (
              <div key={p.name} className="row-card stagger-item flex items-center gap-3 p-4 text-sm">
                <div
                  className="icon-badge icon-badge-warning shrink-0 text-xs font-semibold"
                  style={{ width: '2rem', height: '2rem' }}
                >
                  {p.name[0]?.toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                    <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {p.name}
                    </span>
                    <span style={{ color: 'var(--warning)' }}>₹{Math.round(p.amount).toLocaleString('en-IN')}</span>
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

        <Section title="Failed messages" empty="No failures">
          {data.failedMessages.map((n) => (
            <Row key={n.id} initial={n.template_name[0]} tone="critical" to="/notifications">
              <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                {n.template_name}
              </span>
              <span style={{ color: 'var(--critical)' }}>{n.error_detail ?? 'failed'}</span>
            </Row>
          ))}
          {data.failedMessages.length > 0 && (
            <div className="px-4 py-2.5">
              <Link to="/notifications" className="link-accent text-sm font-medium">
                Go to notifications →
              </Link>
            </div>
          )}
        </Section>
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

  if (to) {
    return (
      <Link to={to} className="glass-card tile-hover stagger-item flex flex-col p-3">
        {inner}
      </Link>
    )
  }
  return <div className="glass-card tile-hover stagger-item flex flex-col p-3">{inner}</div>
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
