import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { BankAccount, DematAccount } from '../../types/database'

type AccountWithBanks = DematAccount & { bank_accounts: BankAccount[] }

export function MyAccountPage() {
  const [accounts, setAccounts] = useState<AccountWithBanks[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase
      .from('demat_accounts')
      .select('*, bank_accounts(*)')
      .then(({ data }) => {
        setAccounts((data ?? []) as AccountWithBanks[])
        setLoading(false)
      })
  }, [])

  if (loading) return <p className="text-gray-500">Loading…</p>

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Your account</h1>
      {accounts.map((a) => (
        <div key={a.id} className="rounded border bg-white p-4">
          <p className="font-medium">{a.holder_name}</p>
          <p className="text-sm text-gray-500">
            {a.phone_e164} · {a.broker ?? 'no broker'} · PAN {a.pan_masked}
          </p>
          {a.bank_accounts?.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {a.bank_accounts.map((b) => (
                <li key={b.id} className="rounded bg-gray-50 px-2 py-1 text-xs text-gray-600">
                  {b.bank_name} ••{b.last4}
                  {b.is_default && ' (default)'}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {accounts.length === 0 && (
        <p className="text-sm text-gray-400">No demat account linked to your login yet.</p>
      )}
    </div>
  )
}
