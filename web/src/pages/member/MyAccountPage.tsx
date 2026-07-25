import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { InlineSpinner } from '../../components/PageSpinner'
import type { DematAccount } from '../../types/database'

export function MyAccountPage() {
  const [accounts, setAccounts] = useState<DematAccount[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase
      .from('demat_accounts')
      .select('*')
      .then(({ data }) => {
        setAccounts((data ?? []) as DematAccount[])
        setLoading(false)
      })
  }, [])

  if (loading) return <InlineSpinner />

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
        Your account
      </h1>
      {accounts.map((a) => (
        <div key={a.id} className="card p-5">
          <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
            {a.holder_name}
          </p>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {a.phone_e164} · {a.broker ?? 'no broker'} · PAN {a.pan_masked}
          </p>
        </div>
      ))}
      {accounts.length === 0 && (
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          No demat account linked to your login yet.
        </p>
      )}
    </div>
  )
}
