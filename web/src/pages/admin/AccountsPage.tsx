import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { describeFunctionError, supabase } from '../../lib/supabase'
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

  async function deleteAccount(id: string, name: string) {
    if (!window.confirm(`Delete ${name}? This is only possible if they have no applications or messages on record.`))
      return
    const { error } = await supabase.from('demat_accounts').delete().eq('id', id)
    if (error) {
      alert(
        error.code === '23503'
          ? `Can't delete ${name} — they have applications or messages on record. Delete those first.`
          : error.message,
      )
      return
    }
    load()
  }

  async function deleteBank(id: string) {
    if (!window.confirm('Remove this bank account?')) return
    const { error } = await supabase.from('bank_accounts').delete().eq('id', id)
    if (error) {
      alert(error.message)
      return
    }
    load()
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            Demat accounts
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {accounts.length} registered
          </p>
        </div>
        <button onClick={() => setShowForm((s) => !s)} className="btn-primary">
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
        <p style={{ color: 'var(--ink-muted)' }}>Loading…</p>
      ) : (
        <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
          {accounts.map((a) => (
            <div key={a.id} className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                    {a.holder_name}
                  </p>
                  <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
                    {a.phone_e164}
                    {a.dp_client_id && ` · Demat a/c ${a.dp_client_id}`} ·{' '}
                    <span className="font-mono" style={{ color: 'var(--ink-secondary)' }}>
                      {revealed[a.id] ?? a.pan_masked}
                    </span>
                    {!revealed[a.id] && (
                      <button onClick={() => revealPan(a.id)} className="link-accent ml-2 text-sm font-medium">
                        Reveal PAN
                      </button>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!a.linked_user_id && <span className="badge badge-neutral">not invited</span>}
                  <button
                    onClick={() => deleteAccount(a.id, a.holder_name)}
                    className="text-xs font-medium hover:underline"
                    style={{ color: 'var(--critical)' }}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {a.bank_accounts?.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {a.bank_accounts.map((b) => (
                    <li key={b.id} className="badge badge-neutral">
                      {b.bank_name} ••{b.last4}
                      {b.is_default && ' (default)'}
                      <button
                        onClick={() => deleteBank(b.id)}
                        aria-label={`Remove ${b.bank_name} bank account`}
                        className="ml-1"
                        style={{ color: 'var(--critical)' }}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {accounts.length === 0 && (
            <p className="p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
              No accounts yet.
            </p>
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
  const [dematAccountNo, setDematAccountNo] = useState('')
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
          broker: null,
          dp_client_id: dematAccountNo || null,
        },
      },
    )

    setSubmitting(false)
    if (fnError || !data?.id) {
      setError(await describeFunctionError(fnError, data))
      return
    }
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} className="card grid grid-cols-2 gap-4 p-5">
      <Field label="Holder name">
        <input required value={holderName} onChange={(e) => setHolderName(e.target.value)} className="input" />
      </Field>
      <Field label="Phone (E.164)">
        <input required value={phone} onChange={(e) => setPhone(e.target.value)} className="input" />
      </Field>
      <Field label="PAN">
        <input required maxLength={10} value={pan} onChange={(e) => setPan(e.target.value)} className="input" />
      </Field>
      <Field label="Demat account no.">
        <input
          required
          value={dematAccountNo}
          onChange={(e) => setDematAccountNo(e.target.value)}
          className="input"
        />
      </Field>

      {error && <p className="badge badge-critical col-span-2 w-fit">{error}</p>}

      <button type="submit" disabled={submitting} className="btn-primary col-span-2 py-2.5">
        {submitting ? 'Saving…' : 'Save account'}
      </button>
    </form>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
      {label}
      <div className="mt-1">{children}</div>
    </label>
  )
}
