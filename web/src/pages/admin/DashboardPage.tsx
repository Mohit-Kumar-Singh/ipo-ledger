import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import type { AllotmentBoardRow, Ipo, Notification } from '../../types/database'

interface DashboardData {
  closingSoon: Ipo[]
  pendingMandate: AllotmentBoardRow[]
  allottedNotSold: AllotmentBoardRow[]
  failedMessages: Notification[]
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const todayStr = new Date().toISOString().slice(0, 10)
      const in7d = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)

      const [closingSoon, board, failedMessages] = await Promise.all([
        supabase.from('ipos').select('*').gte('close_date', todayStr).lte('close_date', in7d).order('close_date'),
        supabase.from('v_allotment_board').select('*'),
        supabase
          .from('notifications')
          .select('*')
          .eq('status', 'FAILED')
          .order('created_at', { ascending: false })
          .limit(20),
      ])

      if (cancelled) return

      const boardRows = (board.data ?? []) as AllotmentBoardRow[]
      setData({
        closingSoon: (closingSoon.data ?? []) as Ipo[],
        pendingMandate: boardRows.filter((r) => r.status === 'APPLIED'),
        allottedNotSold: boardRows.filter((r) => r.status === 'ALLOTTED'),
        failedMessages: (failedMessages.data ?? []) as Notification[],
      })
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading || !data) return <p style={{ color: 'var(--ink-muted)' }}>Loading dashboard…</p>

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Dashboard
        </h1>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          Overview across all accounts and IPOs
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Closing within 7 days" value={data.closingSoon.length} />
        <StatTile label="Awaiting mandate approval" value={data.pendingMandate.length} tone="warning" />
        <StatTile label="Allotted, not sold" value={data.allottedNotSold.length} tone="good" />
        <StatTile label="Failed messages" value={data.failedMessages.length} tone="critical" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section title="IPOs closing within 7 days" empty="Nothing closing soon">
          {data.closingSoon.map((ipo) => (
            <Row key={ipo.id}>
              <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                {ipo.company_name}
              </span>
              <span style={{ color: 'var(--ink-muted)' }}>closes {ipo.close_date}</span>
            </Row>
          ))}
        </Section>

        <Section title="Applications awaiting mandate approval" empty="None pending">
          {data.pendingMandate.map((r) => (
            <Row key={r.application_id}>
              <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                {r.holder_name}
              </span>
              <span style={{ color: 'var(--ink-muted)' }}>{r.company_name}</span>
            </Row>
          ))}
        </Section>

        <Section title="Allotted, not yet sold" empty="Nothing outstanding">
          {data.allottedNotSold.map((r) => (
            <Row key={r.application_id}>
              <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                {r.holder_name}
              </span>
              <span style={{ color: 'var(--ink-muted)' }}>
                {r.company_name} · listing {r.listing_date ?? '—'}
              </span>
            </Row>
          ))}
        </Section>

        <Section title="Failed messages" empty="No failures">
          {data.failedMessages.map((n) => (
            <Row key={n.id}>
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
  label,
  value,
  tone = 'info',
}: {
  label: string
  value: number
  tone?: 'info' | 'warning' | 'good' | 'critical'
}) {
  const toneColor = {
    info: 'var(--accent)',
    warning: 'var(--warning)',
    good: 'var(--good)',
    critical: 'var(--critical)',
  }[tone]
  const animated = useCountUp(value)

  return (
    <div className="card p-4">
      <p className="text-sm font-medium" style={{ color: 'var(--ink-muted)' }}>
        {label}
      </p>
      <p
        className="mt-2 text-3xl font-semibold"
        style={{ color: value > 0 ? toneColor : 'var(--ink-primary)', fontVariantNumeric: 'tabular-nums' }}
      >
        {animated}
      </p>
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

function Row({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 text-sm" style={{ borderColor: 'var(--border)' }}>
      {children}
    </div>
  )
}
