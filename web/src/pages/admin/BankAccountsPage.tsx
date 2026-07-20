import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { supabase } from '../../lib/supabase'
import type { BankAccount, DematAccount } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

type BankRow = BankAccount & { demat_accounts: Pick<DematAccount, 'holder_name'> }

interface EditingBank {
  id: string
  dematId: string
  holderName: string
  upi: string
  bankName: string
  isDefault: boolean
}

export function BankAccountsPage() {
  const [banks, setBanks] = useState<BankRow[]>([])
  const [demats, setDemats] = useState<DematAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<EditingBank | null>(null)

  async function load() {
    setLoading(true)
    const [banksRes, dematsRes] = await Promise.all([
      supabase
        .from('bank_accounts')
        .select('*, demat_accounts(holder_name)')
        .order('is_default', { ascending: false }),
      supabase.from('demat_accounts').select('*').order('holder_name'),
    ])
    setBanks((banksRes.data ?? []) as BankRow[])
    setDemats((dematsRes.data ?? []) as DematAccount[])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  function startEdit(b: BankRow) {
    setShowForm(false)
    setEditing({
      id: b.id,
      dematId: b.demat_id,
      holderName: b.account_holder_name ?? '',
      upi: b.upi_id ?? '',
      bankName: b.bank_name ?? '',
      isDefault: b.is_default,
    })
  }

  async function deleteBank(id: string) {
    if (!window.confirm('Remove this bank/UPI account?')) return
    const { error } = await supabase.from('bank_accounts').delete().eq('id', id)
    if (error) {
      alert(error.message)
      return
    }
    load()
  }

  // Grouped by linked demat account, so combinations (which holder ×
  // which bank/UPI) are easy to scan when deciding how to apply.
  const grouped = new Map<string, { holderName: string; rows: BankRow[] }>()
  for (const b of banks) {
    const key = b.demat_id
    if (!grouped.has(key)) grouped.set(key, { holderName: b.demat_accounts?.holder_name ?? 'Unknown', rows: [] })
    grouped.get(key)!.rows.push(b)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            Bank / UPI accounts
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {banks.length} linked across {demats.length} demat account{demats.length === 1 ? '' : 's'} — the
            holder × bank/UPI combinations you apply IPOs from.
          </p>
        </div>
        <button
          onClick={() => {
            setEditing(null)
            setShowForm((s) => !s)
          }}
          className="btn-primary"
          disabled={demats.length === 0}
          title={demats.length === 0 ? 'Add a demat account first' : undefined}
        >
          {showForm ? 'Cancel' : '+ Add bank/UPI account'}
        </button>
      </div>

      {demats.length === 0 && !loading && (
        <p className="badge badge-warning w-fit">Add a demat account on the Accounts page first.</p>
      )}

      {showForm && (
        <BankForm
          demats={demats}
          onCancel={() => setShowForm(false)}
          onDone={() => {
            setShowForm(false)
            load()
          }}
        />
      )}

      {editing && (
        <BankForm
          demats={demats}
          existing={editing}
          onCancel={() => setEditing(null)}
          onDone={() => {
            setEditing(null)
            load()
          }}
        />
      )}

      {loading ? (
        <InlineSpinner />
      ) : banks.length === 0 ? (
        <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
          No bank/UPI accounts yet.
        </p>
      ) : (
        <div className="space-y-4">
          {Array.from(grouped.entries()).map(([dematId, group]) => (
            <div key={dematId} className="card p-4">
              <p className="mb-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
                {group.holderName}
              </p>
              <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {group.rows.map((b) => (
                  <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="text-sm">
                      <span style={{ color: 'var(--ink-primary)' }}>{b.account_holder_name}</span>
                      {b.upi_id && (
                        <span style={{ color: 'var(--ink-muted)' }} className="ml-2">
                          {b.upi_id}
                        </span>
                      )}
                      {b.bank_name && (
                        <span style={{ color: 'var(--ink-muted)' }} className="ml-2">
                          {b.bank_name}
                        </span>
                      )}
                      {b.is_default && <span className="badge badge-info ml-2">default</span>}
                    </div>
                    <div className="flex gap-3">
                      <button onClick={() => startEdit(b)} className="link-accent text-xs font-medium">
                        Edit
                      </button>
                      <button
                        onClick={() => deleteBank(b.id)}
                        className="text-xs font-medium hover:underline"
                        style={{ color: 'var(--critical)' }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function BankForm({
  demats,
  existing,
  onCancel,
  onDone,
}: {
  demats: DematAccount[]
  existing?: EditingBank
  onCancel: () => void
  onDone: () => void
}) {
  const [dematId, setDematId] = useState(existing?.dematId ?? '')
  const [holderName, setHolderName] = useState(existing?.holderName ?? '')
  const [upi, setUpi] = useState(existing?.upi ?? '')
  const [bankName, setBankName] = useState(existing?.bankName ?? '')
  const [isDefault, setIsDefault] = useState(existing?.isDefault ?? false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    const payload = {
      demat_id: dematId,
      account_holder_name: holderName.trim() || null,
      upi_id: upi.trim() || null,
      bank_name: bankName.trim() || null,
      is_default: isDefault,
    }

    const { error } = existing
      ? await supabase.from('bank_accounts').update(payload).eq('id', existing.id)
      : await supabase.from('bank_accounts').insert(payload)

    setSubmitting(false)
    if (error) {
      setError(error.message)
      return
    }
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} className="card grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
      <Field label="Linked demat account">
        <select required value={dematId} onChange={(e) => setDematId(e.target.value)} className="input">
          <option value="">Select account</option>
          {demats.map((d) => (
            <option key={d.id} value={d.id}>
              {d.holder_name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Account holder name" hint="optional">
        <input value={holderName} onChange={(e) => setHolderName(e.target.value)} className="input" />
      </Field>
      <Field label="UPI ID">
        <input value={upi} onChange={(e) => setUpi(e.target.value)} placeholder="name@bank" className="input" />
      </Field>
      <Field label="Bank" hint="optional">
        <input value={bankName} onChange={(e) => setBankName(e.target.value)} className="input" />
      </Field>
      <label className="col-span-1 flex items-center gap-2 text-sm sm:col-span-2" style={{ color: 'var(--ink-secondary)' }}>
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        Use as default for this account
      </label>

      {error && <p className="badge badge-critical col-span-1 w-fit sm:col-span-2">{error}</p>}

      <div className="col-span-1 flex gap-2 sm:col-span-2">
        <button type="submit" disabled={submitting} className="btn-primary flex-1 py-2.5">
          {submitting ? 'Saving…' : existing ? 'Save changes' : 'Save bank/UPI account'}
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary">
          Cancel
        </button>
      </div>
    </form>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
      <span className="flex items-baseline justify-between gap-2">
        {label}
        {hint && (
          <span className="text-xs font-normal" style={{ color: 'var(--ink-muted)' }}>
            {hint}
          </span>
        )}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  )
}
