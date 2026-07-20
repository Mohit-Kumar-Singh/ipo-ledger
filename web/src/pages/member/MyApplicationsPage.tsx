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

  if (loading) return <p className="text-gray-500">Loading…</p>

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Your applications</h1>
      <div className="divide-y rounded border bg-white">
        {applications.map((a) => (
          <div key={a.id} className="p-3">
            <div className="flex items-center justify-between">
              <p className="font-medium">{a.ipos?.company_name}</p>
              <StatusBadge status={a.status} />
            </div>
            <p className="text-sm text-gray-500">
              {a.lots} lot(s) · ₹{a.bid_amount ?? '—'}
              {a.ipos?.listing_date && ` · listing ${a.ipos.listing_date}`}
            </p>
            {a.status === 'ALLOTTED' && (
              <p className="mt-1 text-sm text-green-700">
                Allotted — please sell on listing day{a.ipos?.listing_date ? ` (${a.ipos.listing_date})` : ''}.
              </p>
            )}
          </div>
        ))}
        {applications.length === 0 && (
          <p className="p-3 text-sm text-gray-400">No applications yet.</p>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: Application['status'] }) {
  const colors: Record<Application['status'], string> = {
    APPLIED: 'bg-blue-100 text-blue-700',
    ALLOTTED: 'bg-green-100 text-green-700',
    NOT_ALLOTTED: 'bg-gray-100 text-gray-600',
    SOLD: 'bg-purple-100 text-purple-700',
  }
  return <span className={`rounded px-2 py-0.5 text-xs ${colors[status]}`}>{status}</span>
}
