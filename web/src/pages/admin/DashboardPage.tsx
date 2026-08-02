import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Clock, Landmark, Wallet } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Skeleton } from '../../components/PageSpinner'
import { AreaChart, type AreaChartPoint } from '../../components/AreaChart'
import { computeProfitSplit } from '../../lib/profitSplit'
import type { AllotmentBoardRow, Ipo, Notification } from '../../types/database'

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

interface DashboardData {
  closingSoon: Ipo[]
  pendingMandate: AllotmentBoardRow[]
  allottedNotSold: AllotmentBoardRow[]
  failedMessages: Notification[]
  activity: AreaChartPoint[]
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

// Buckets application applied_at timestamps into the last 7 calendar days
// (today included), so the dashboard has something real to chart instead of
// a hand-rolled/fake series.
function buildActivitySeries(appliedDates: string[]): AreaChartPoint[] {
  const days: { key: string; label: string }[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000)
    days.push({ key: d.toISOString().slice(0, 10), label: d.toLocaleDateString('en-US', { weekday: 'short' }) })
  }
  const counts = new Map<string, number>()
  for (const iso of appliedDates) {
    const key = iso.slice(0, 10)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return days.map((d) => ({ label: d.label, value: counts.get(d.key) ?? 0 }))
}

export function DashboardPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [markingPaid, setMarkingPaid] = useState<string | null>(null)

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
      const since7d = new Date(Date.now() - 6 * 86400000).toISOString()

      const [closingSoon, board, failedMessages, recentApplications] = await Promise.all([
        supabase.from('ipos').select('*').gte('close_date', todayStr).lte('close_date', in7d).order('close_date'),
        supabase.from('v_allotment_board').select('*'),
        supabase
          .from('notifications')
          .select('*')
          .eq('status', 'FAILED')
          .order('created_at', { ascending: false })
          .limit(20),
        supabase.from('applications').select('applied_at').gte('applied_at', since7d),
      ])

      if (cancelled) return

      const boardRows = (board.data ?? []) as AllotmentBoardRow[]
      setData({
        closingSoon: (closingSoon.data ?? []) as Ipo[],
        pendingMandate: boardRows.filter((r) => r.status === 'APPLIED'),
        allottedNotSold: boardRows.filter((r) => r.status === 'ALLOTTED'),
        failedMessages: (failedMessages.data ?? []) as Notification[],
        activity: buildActivitySeries(((recentApplications.data ?? []) as { applied_at: string }[]).map((a) => a.applied_at)),
        pendingPayouts: isAdmin
          ? buildPendingPayouts(boardRows.filter((r) => r.status === 'SOLD'), profile?.full_name ?? '')
          : [],
      })
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading || !data) return <DashboardSkeleton />

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

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile icon={Clock} label="Closing within 7 days" value={data.closingSoon.length} tone="info" />
        <StatTile icon={Landmark} label="Awaiting mandate approval" value={data.pendingMandate.length} tone="warning" />
        <StatTile icon={CheckCircle2} label="Allotted, not sold" value={data.allottedNotSold.length} tone="good" />
        <StatTile icon={AlertTriangle} label="Failed messages" value={data.failedMessages.length} tone="critical" />
        {isAdmin && (
          <StatTile
            icon={Wallet}
            label="Payouts pending"
            value={data.pendingPayouts.reduce((sum, p) => sum + p.amount, 0)}
            tone="warning"
            format={(n) => `₹${n.toLocaleString('en-IN')}`}
          />
        )}
      </div>

      <div className="card stagger-item p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            Applications this week
          </h2>
          <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            Last 7 days
          </span>
        </div>
        <AreaChart data={data.activity} colorVar="--btn-primary-bg" height={180} />
      </div>

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

// Counts up from 0 to `target` on mount/change instead of snapping straight
// to the number — small nod to the animated-figures feel of consumer
// investing apps (Groww etc.) on the dashboard's headline stats.
function useCountUp(target: number, duration = 500) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    if (target === 0) {
      setValue(0)
      return
    }
    let raf: number
    const start = performance.now()
    function tick(now: number) {
      const t = Math.min((now - start) / duration, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(Math.round(target * eased))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return value
}

function StatTile({
  icon: Icon,
  label,
  value,
  tone = 'info',
  format,
}: {
  icon: typeof Clock
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
        <Icon size={20} strokeWidth={2} />
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

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card space-y-3 p-4">
            <Skeleton className="h-11 w-11" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-8 w-14" />
          </div>
        ))}
      </div>

      <div className="card p-5">
        <Skeleton className="mb-4 h-4 w-40" />
        <Skeleton className="h-44 w-full" />
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
