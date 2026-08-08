import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertIcon, CheckCircleIcon, ClockIcon, LawIcon, LinkIcon, CreditCardIcon } from '@primer/octicons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Skeleton } from '../../components/PageSpinner'
import { AttributionChart } from '../../components/AttributionChart'
import { IpoProgressGauge } from '../../components/IpoProgressGauge'
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
  BankAccount,
  BankLinkRequest,
  DematAccount,
  DematLinkRequest,
  Ipo,
  Notification,
  Profile,
} from '../../types/database'

interface LinkRequestRow extends DematLinkRequest {
  profiles: Pick<Profile, 'full_name'> | null
  demat_accounts: Pick<DematAccount, 'holder_name'> | null
}

interface BankLinkRequestRow extends BankLinkRequest {
  profiles: Pick<Profile, 'full_name'> | null
  bank_accounts: Pick<BankAccount, 'account_holder_name'> | null
}

// Unifies demat and bank/UPI link requests into one list for the admin
// "Pending link requests" panel — same review action either way, just a
// different target account and decision RPC.
interface UnifiedLinkRequest {
  id: string
  kind: 'demat' | 'bank'
  status: LinkRequestRow['status']
  requestedAt: string
  requesterName: string
  targetName: string
}

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
  applied: number
  totalActive: number
  gmpNotes: string | null
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
  linkRequests: LinkRequestRow[]
  bankLinkRequests: BankLinkRequestRow[]
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
  const [decidingId, setDecidingId] = useState<string | null>(null)
  const [expandedIpoId, setExpandedIpoId] = useState<string | null>(null)
  // Fires the high-GMP heads-up as a toast once per calendar day, not on
  // every visit to (or realtime-triggered reload of) the Dashboard — a
  // plain useRef only survives while this component stays mounted, so
  // navigating away and back (or a page reload) reset it and re-fired the
  // toast on every single visit. localStorage persists across all of that;
  // the guard is "have we already shown it today," not "this mount."
  const hasShownGmpToast = useRef(localStorage.getItem('gmpToastShownDate') === new Date().toISOString().slice(0, 10))

  async function decideLinkRequest(kind: 'demat' | 'bank', id: string, approve: boolean) {
    setDecidingId(id)
    const rpcName = kind === 'demat' ? 'decide_demat_link_request' : 'decide_bank_link_request'
    const { error } = await supabase.rpc(rpcName, { p_request_id: id, p_approve: approve })
    setDecidingId(null)
    if (error) {
      alert(error.message)
      return
    }
    setData((d) =>
      d
        ? {
            ...d,
            linkRequests: kind === 'demat' ? d.linkRequests.filter((r) => r.id !== id) : d.linkRequests,
            bankLinkRequests: kind === 'bank' ? d.bankLinkRequests.filter((r) => r.id !== id) : d.bankLinkRequests,
          }
        : d,
    )
  }

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

      const [closingSoon, allIpos, activeAccounts, board, failedMessages, attributionRes, linkRequests, bankLinkRequests] =
        await Promise.all([
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
          supabase
            .from('demat_link_requests')
            // demat_link_requests has two FKs into profiles (member_id,
            // decided_by) — the embed must be disambiguated with !member_id,
            // or PostgREST can't tell which relationship to follow and the
            // whole query errors out.
            .select('*, profiles!member_id(full_name), demat_accounts(holder_name)')
            .order('requested_at', { ascending: false }),
          supabase
            .from('bank_link_requests')
            .select('*, profiles!member_id(full_name), bank_accounts(account_holder_name)')
            .order('requested_at', { ascending: false }),
        ])

      if (cancelled) return

      // Top 8 most-recently-opened IPOs (Profile mirrors the top 4 of this
      // same ordering) — resolving names is a second round trip since it
      // depends on which ids show up in that scoped set.
      const scopedRows = topRecentIpoAttributionRows((attributionRes.data ?? []) as ApplicationAttributionRow[], 8)
      const nameById = await resolveAttributionNames(scopedRows)
      if (cancelled) return

      const boardRows = (board.data ?? []) as AllotmentBoardRow[]

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
            applied: appliedIds.size,
            totalActive,
            gmpNotes: ipo.gmp_notes,
            remainingHolderNames,
          }
        })
        // No point showing a progress tile for an IPO nobody has applied to
        // yet — it's not "in progress," there's nothing to track.
        .filter((p) => p.applied > 0)
        .sort((a, b) => a.endDate.localeCompare(b.endDate))

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
        pendingMandate: boardRows.filter((r) => r.status === 'APPLIED'),
        allottedNotSold: boardRows.filter((r) => r.status === 'ALLOTTED'),
        failedMessages: (failedMessages.data ?? []) as Notification[],
        attribution: computeIpoAttribution(scopedRows, nameById).sort((a, b) => b.openDate.localeCompare(a.openDate)),
        ipoProgress,
        highGmpAlerts,
        pendingPayouts: isAdmin
          ? buildPendingPayouts(boardRows.filter((r) => r.status === 'SOLD'), profile?.full_name ?? '')
          : [],
        linkRequests: (linkRequests.data ?? []) as LinkRequestRow[],
        bankLinkRequests: (bankLinkRequests.data ?? []) as BankLinkRequestRow[],
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

  const unifiedLinkRequests: UnifiedLinkRequest[] = [
    ...data.linkRequests.map((r) => ({
      id: r.id,
      kind: 'demat' as const,
      status: r.status,
      requestedAt: r.requested_at,
      requesterName: r.profiles?.full_name ?? 'Unknown',
      targetName: r.demat_accounts?.holder_name ?? 'an account',
    })),
    ...data.bankLinkRequests.map((r) => ({
      id: r.id,
      kind: 'bank' as const,
      status: r.status,
      requestedAt: r.requested_at,
      requesterName: r.profiles?.full_name ?? 'Unknown',
      targetName: r.bank_accounts?.account_holder_name ?? 'a bank/UPI account',
    })),
  ].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))

  const pendingLinkRequests = unifiedLinkRequests.filter((r) => r.status === 'PENDING')

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

      <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
        <StatTile icon={ClockIcon} label="Closing within 7 days" value={data.closingSoon.length} tone="info" />
        <StatTile icon={LawIcon} label="Awaiting mandate approval" value={data.pendingMandate.length} tone="warning" />
        {isAdmin && (
          <StatTile icon={LinkIcon} label="Pending link requests" value={pendingLinkRequests.length} tone="warning" />
        )}
        <StatTile icon={CheckCircleIcon} label="Allotted, not sold" value={data.allottedNotSold.length} tone="good" />
        <StatTile icon={AlertIcon} label="Failed messages" value={data.failedMessages.length} tone="critical" />
        {isAdmin && (
          <StatTile
            icon={CreditCardIcon}
            label="Payouts pending"
            value={data.pendingPayouts.reduce((sum, p) => sum + p.amount, 0)}
            tone="warning"
            format={(n) => `₹${n.toLocaleString('en-IN')}`}
          />
        )}
      </div>

      {data.ipoProgress.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
            IPO progress
          </h2>
          {/* Flexbox, not CSS grid: a grid item can only grow by spanning
              whole tracks, which snaps the tile to double width the instant
              the span changes (before the inner content even starts
              animating). flex-basis is itself a transitionable property, so
              switching to flex-wrap lets the expanding tile's width animate
              smoothly in one continuous motion instead of jump-then-reveal. */}
          <div className="flex flex-wrap gap-5">
            {data.ipoProgress.map((p) => {
              const expanded = expandedIpoId === p.ipoId
              return (
                <div
                  key={p.ipoId}
                  style={{
                    flexBasis: expanded ? 500 : 260,
                    flexGrow: 0,
                    flexShrink: 0,
                    transition: 'flex-basis 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
                  }}
                >
                  <IpoProgressGauge
                    companyName={p.companyName}
                    startDate={p.openDate}
                    endDate={p.endDate}
                    applied={p.applied}
                    total={p.totalActive}
                    gmpNotes={p.gmpNotes}
                    remainingHolderNames={p.remainingHolderNames}
                    expanded={expanded}
                    onToggleExpanded={() => setExpandedIpoId((id) => (id === p.ipoId ? null : p.ipoId))}
                  />
                </div>
              )
            })}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
          Application credit by IPO
        </h2>
        {data.attribution.length === 0 ? (
          <p className="card p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            No applications yet.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {data.attribution.map((a) => (
              <div key={a.ipoId} className="card stagger-item min-w-0 p-4">
                <AttributionChart attribution={a} />
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section title="IPOs closing within 7 days" empty="Nothing closing soon">
          {data.closingSoon.map((ipo) => (
            <Row key={ipo.id} initial={ipo.company_name[0]} tone="info">
              <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                {ipo.company_name}
              </span>
              <span style={{ color: 'var(--ink-muted)' }}>closes {ipo.close_date}</span>
            </Row>
          ))}
        </Section>

        <Section title="Applications awaiting mandate approval" empty="None pending">
          {data.pendingMandate.map((r) => (
            <Row key={r.application_id} initial={r.holder_name[0]} tone="warning">
              <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                {r.holder_name}
              </span>
              <span style={{ color: 'var(--ink-muted)' }}>{r.company_name}</span>
            </Row>
          ))}
        </Section>

        <Section title="Allotted, not yet sold" empty="Nothing outstanding">
          {data.allottedNotSold.map((r) => (
            <Row key={r.application_id} initial={r.holder_name[0]} tone="good">
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
          <Section title="Pending link requests" empty="None pending">
            {pendingLinkRequests.map((r) => (
              <div key={`${r.kind}-${r.id}`} className="stagger-item flex items-center gap-3 px-4 py-2.5 text-sm">
                <div
                  className="icon-badge icon-badge-warning shrink-0 text-xs font-semibold"
                  style={{ width: '2rem', height: '2rem' }}
                >
                  {r.requesterName[0]?.toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                    {r.requesterName}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                    wants to link {r.targetName} <span className="badge badge-neutral ml-1">{r.kind}</span>
                  </p>
                </div>
                <div className="flex shrink-0 gap-3">
                  <button
                    onClick={() => decideLinkRequest(r.kind, r.id, true)}
                    disabled={decidingId === r.id}
                    className="link-accent text-xs font-medium disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decideLinkRequest(r.kind, r.id, false)}
                    disabled={decidingId === r.id}
                    className="text-xs font-medium hover:underline disabled:opacity-50"
                    style={{ color: 'var(--critical)' }}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </Section>
        )}

        {!isAdmin && (
          <Section title="Your link requests" empty="No link requests yet">
            {unifiedLinkRequests.map((r) => (
              <Row
                key={`${r.kind}-${r.id}`}
                initial={r.targetName[0]}
                tone={r.status === 'APPROVED' ? 'good' : r.status === 'REJECTED' ? 'critical' : 'warning'}
              >
                <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                  {r.targetName} <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>({r.kind})</span>
                </span>
                <span style={{ color: 'var(--ink-muted)' }}>{r.status}</span>
              </Row>
            ))}
          </Section>
        )}

        {isAdmin && (
          <Section title="Payouts pending" empty="Nothing owed right now">
            {data.pendingPayouts.map((p) => (
              <div key={p.name} className="stagger-item flex items-center gap-3 px-4 py-2.5 text-sm">
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
            <Row key={n.id} initial={n.template_name[0]} tone="critical">
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
}: {
  icon: typeof ClockIcon
  label: string
  value: number
  tone?: 'info' | 'warning' | 'good' | 'critical'
  format?: (n: number) => string
}) {
  const toneColor = {
    info: 'var(--accent)',
    warning: 'var(--warning)',
    good: 'var(--good)',
    critical: 'var(--critical)',
  }[tone]
  const animated = useCountUp(value)

  return (
    <div className="card stagger-item flex flex-col gap-3 p-4">
      <div className={`icon-badge icon-badge-${tone}`}>
        <Icon size={20} />
      </div>
      <div>
        <p className="text-sm font-medium" style={{ color: 'var(--ink-muted)' }}>
          {label}
        </p>
        <p
          className="mt-1 text-3xl font-semibold"
          style={{ color: value > 0 ? toneColor : 'var(--ink-primary)', fontVariantNumeric: 'tabular-nums' }}
        >
          {format ? format(animated) : animated}
        </p>
      </div>
    </div>
  )
}

function Section({ title, empty, children }: { title: string; empty: string; children: ReactNode }) {
  const hasChildren = Array.isArray(children) ? children.some(Boolean) : Boolean(children)
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
        {title}
      </h2>
      <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
        {hasChildren ? children : <p className="p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>{empty}</p>}
      </div>
    </section>
  )
}

function Row({
  children,
  initial,
  tone = 'info',
}: {
  children: ReactNode
  initial: string
  tone?: 'info' | 'warning' | 'good' | 'critical'
}) {
  return (
    <div className="stagger-item flex items-center gap-3 px-4 py-2.5 text-sm" style={{ borderColor: 'var(--border)' }}>
      <div
        className={`icon-badge icon-badge-${tone} shrink-0 text-xs font-semibold`}
        style={{ width: '2rem', height: '2rem' }}
      >
        {initial.toUpperCase()}
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-0.5">{children}</div>
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>

      <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card space-y-3 p-4">
            <Skeleton className="h-11 w-11" />
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
