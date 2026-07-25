import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { Application, BankAccount, Ipo } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

type ApplicationRow = Application & {
  ipos: Pick<Ipo, 'company_name' | 'listing_date'>
  bank_accounts: Pick<BankAccount, 'account_holder_name' | 'bank_name' | 'last4' | 'upi_id'> | null
}

export function MyApplicationsPage() {
  const [applications, setApplications] = useState<ApplicationRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase
      .from('applications')
      .select('*, ipos(company_name, listing_date), bank_accounts(account_holder_name, bank_name, last4, upi_id)')
      .order('applied_at', { ascending: false })
      .then(({ data }) => {
        setApplications((data ?? []) as ApplicationRow[])
        setLoading(false)
      })
  }, [])

  if (loading) return <InlineSpinner />

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
            {a.bank_accounts && (
              <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
                via{' '}
                {[a.bank_accounts.account_holder_name, a.bank_accounts.bank_name, a.bank_accounts.upi_id]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
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
