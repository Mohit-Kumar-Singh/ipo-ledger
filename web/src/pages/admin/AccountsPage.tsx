import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { supabase } from '../../lib/supabase'
import type { BankAccount, DematAccount } from '../../types/database'

type AccountWithBanks = DematAccount & { bank_accounts: BankAccount[] }

export function AccountsPage() {
  const [accounts, setAccounts] = useState<AccountWithBanks[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [revealed, setRevealed] = useState<Record<string, string>>({})

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('demat_accounts')
      .select('*, bank_accounts(*)')
      .order('created_at', { ascending: false })
    setAccounts((data ?? []) as AccountWithBanks[])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function revealPan(id: string) {
    const { data, error } = await supabase.functions.invoke<{ pan: string }>('reveal-pan', {
      body: { demat_id: id },
    })
    if (!error && data) setRevealed((r) => ({ ...r, [id]: data.pan }))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Demat accounts</h1>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="rounded bg-purple-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-800"
        >
          {showForm ? 'Cancel' : '+ Add account'}
        </button>
      </div>

      {showForm && (
        <AddAccountForm
          onDone={() => {
            setShowForm(false)
            load()
          }}
        />
      )}

      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : (
        <div className="divide-y rounded border bg-white">
          {accounts.map((a) => (
            <div key={a.id} className="p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{a.holder_name}</p>
                  <p className="text-sm text-gray-500">
                    {a.phone_e164} · {a.broker ?? 'no broker'} ·{' '}
                    <span className="font-mono">{revealed[a.id] ?? a.pan_masked}</span>
                    {!revealed[a.id] && (
                      <button
                        onClick={() => revealPan(a.id)}
                        className="ml-2 text-purple-700 hover:underline"
                      >
                        Reveal PAN
                      </button>
                    )}
                  </p>
                </div>
                {!a.linked_user_id && (
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                    not invited
                  </span>
                )}
              </div>
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
            <p className="p-3 text-sm text-gray-400">No accounts yet.</p>
          )}
        </div>
      )}
    </div>
  )
}

function AddAccountForm({ onDone }: { onDone: () => void }) {
  const [holderName, setHolderName] = useState('')
  const [phone, setPhone] = useState('+91')
  const [pan, setPan] = useState('')
  const [broker, setBroker] = useState('')
  const [dpClientId, setDpClientId] = useState('')
  const [bankName, setBankName] = useState('')
  const [last4, setLast4] = useState('')
  const [upiId, setUpiId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    const { data, error: fnError } = await supabase.functions.invoke<{ id?: string; error?: string }>(
      'add-demat',
      {
        body: {
          holder_name: holderName,
          phone_e164: phone,
          pan: pan.toUpperCase(),
          broker: broker || null,
          dp_client_id: dpClientId || null,
        },
      },
    )

    if (fnError || !data?.id) {
      setError(data?.error ?? fnError?.message ?? 'Failed to save account')
      setSubmitting(false)
      return
    }
    const dematId = data.id

    if (bankName && last4) {
      const { error: bankError } = await supabase.from('bank_accounts').insert({
        demat_id: dematId,
        bank_name: bankName,
        last4,
        upi_id: upiId || null,
        is_default: true,
      })
      if (bankError) {
        setError(bankError.message)
        setSubmitting(false)
        return
      }
    }

    setSubmitting(false)
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3 rounded border bg-white p-4">
      <Field label="Holder name">
        <input required value={holderName} onChange={(e) => setHolderName(e.target.value)} className="input" />
      </Field>
      <Field label="Phone (E.164)">
        <input required value={phone} onChange={(e) => setPhone(e.target.value)} className="input" />
      </Field>
      <Field label="PAN">
        <input required maxLength={10} value={pan} onChange={(e) => setPan(e.target.value)} className="input" />
      </Field>
      <Field label="Broker">
        <input value={broker} onChange={(e) => setBroker(e.target.value)} className="input" />
      </Field>
      <Field label="DP / Client ID">
        <input value={dpClientId} onChange={(e) => setDpClientId(e.target.value)} className="input" />
      </Field>
      <Field label="Bank name">
        <input value={bankName} onChange={(e) => setBankName(e.target.value)} className="input" />
      </Field>
      <Field label="Account last 4 digits">
        <input maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value)} className="input" />
      </Field>
      <Field label="UPI ID (optional)">
        <input value={upiId} onChange={(e) => setUpiId(e.target.value)} className="input" />
      </Field>

      {error && <p className="col-span-2 text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="col-span-2 rounded bg-purple-700 py-2 text-sm font-medium text-white hover:bg-purple-800 disabled:opacity-50"
      >
        {submitting ? 'Saving…' : 'Save account'}
      </button>
    </form>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm text-gray-700">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  )
}
