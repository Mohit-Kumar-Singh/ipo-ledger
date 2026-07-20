import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import type { AllotmentBoardRow, Ipo, Notification } from '../../types/database'

interface DashboardData {
  closingSoon: Ipo[]
  pendingMandate: AllotmentBoardRow[]
  unchecked: AllotmentBoardRow[]
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
      const nowIso = new Date().toISOString()
      const in7d = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
      const h24Ago = new Date(Date.now() - 24 * 3600000).toISOString()

      const [closingSoon, board, failedMessages] = await Promise.all([
        supabase
          .from('ipos')
          .select('*')
          .gte('close_date', nowIso.slice(0, 10))
          .lte('close_date', in7d)
          .order('close_date'),
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
        unchecked: boardRows.filter((r) => r.status === 'APPLIED' && r.listing_date !== null),
        allottedNotSold: boardRows.filter((r) => r.status === 'ALLOTTED'),
        failedMessages: (failedMessages.data ?? []) as Notification[],
      })
      setLoading(false)
      void h24Ago
      void nowIso
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading || !data) return <p className="text-gray-500">Loading dashboard…</p>

  return (
    <div className="space-y-8">
      <h1 className="text-lg font-semibold">Dashboard</h1>

      <Section title="IPOs closing within 7 days" empty="Nothing closing soon">
        {data.closingSoon.map((ipo) => (
          <Row key={ipo.id}>
            <span className="font-medium">{ipo.company_name}</span>
            <span className="text-gray-500">closes {ipo.close_date}</span>
          </Row>
        ))}
      </Section>

      <Section title="Applications awaiting mandate approval" empty="None pending">
        {data.pendingMandate.map((r) => (
          <Row key={r.application_id}>
            <span className="font-medium">{r.holder_name}</span>
            <span className="text-gray-500">{r.company_name}</span>
          </Row>
        ))}
      </Section>

      <Section title="Allotted, not yet sold" empty="Nothing outstanding">
        {data.allottedNotSold.map((r) => (
          <Row key={r.application_id}>
            <span className="font-medium">{r.holder_name}</span>
            <span className="text-gray-500">
              {r.company_name} · listing {r.listing_date ?? '—'}
            </span>
          </Row>
        ))}
      </Section>

      <Section title="Failed messages" empty="No failures">
        {data.failedMessages.map((n) => (
          <Row key={n.id}>
            <span className="font-medium">{n.template_name}</span>
            <span className="text-red-600">{n.error_detail ?? 'failed'}</span>
          </Row>
        ))}
        {data.failedMessages.length > 0 && (
          <Link to="/notifications" className="text-sm text-purple-700 hover:underline">
            Go to notifications →
          </Link>
        )}
      </Section>
    </div>
  )
}

function Section({
  title,
  empty,
  children,
}: {
  title: string
  empty: string
  children: ReactNode
}) {
  const hasChildren = Array.isArray(children) ? children.some(Boolean) : Boolean(children)
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-gray-700">{title}</h2>
      <div className="divide-y rounded border bg-white">
        {hasChildren ? children : <p className="p-3 text-sm text-gray-400">{empty}</p>}
      </div>
    </section>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-between px-3 py-2 text-sm">{children}</div>
}
