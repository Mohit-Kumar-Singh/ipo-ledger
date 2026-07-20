import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { Application, Ipo } from '../../types/database'

type ApplicationRow = Application & { ipos: Pick<Ipo, 'company_name' | 'listing_date'> }

export function MyApplicationsPage() {
  const [applications, setApplications] = useState<ApplicationRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase
      .from('applications')
      .select('*, ipos(company_name, listing_date)')
      .order('applied_at', { ascending: false })
      .then(({ data }) => {
        setApplications((data ?? []) as ApplicationRow[])
        setLoading(false)
      })
  }, [])

  if (loading) return <p style={{ color: 'var(--ink-muted)' }}>Loading…</p>

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
        Your applications
      </h1>
      <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
        {applications.map((a) => (
          <div key={a.id} className="p-4">
            <div className="flex items-center justify-between">
              <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                {a.ipos?.company_name}
              </p>
              <StatusBadge status={a.status} />
            </div>
            <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
              {a.lots} lot(s) · ₹{a.bid_amount ?? '—'}
              {a.ipos?.listing_date && ` · listing ${a.ipos.listing_date}`}
            </p>
            {a.status === 'ALLOTTED' && (
              <p className="mt-1 text-sm font-medium" style={{ color: 'var(--good)' }}>
                Allotted — please sell on listing day{a.ipos?.listing_date ? ` (${a.ipos.listing_date})` : ''}.
              </p>
            )}
          </div>
        ))}
        {applications.length === 0 && (
          <p className="p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            No applications yet.
          </p>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: Application['status'] }) {
  const classes: Record<Application['status'], string> = {
    APPLIED: 'badge-info',
    ALLOTTED: 'badge-good',
    NOT_ALLOTTED: 'badge-neutral',
    SOLD: 'badge-violet',
  }
  return <span className={`badge ${classes[status]}`}>{status.replace('_', ' ')}</span>
}
