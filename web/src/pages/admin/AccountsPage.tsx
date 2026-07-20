import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { describeFunctionError, supabase } from '../../lib/supabase'
import type { BankAccount, DematAccount } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

type AccountWithBanks = DematAccount & { bank_accounts: BankAccount[] }
type EditingAccount = { id: string; holderName: string; phoneDigits: string; pan: string; dematAccountNo: string }

export function AccountsPage() {
  const [accounts, setAccounts] = useState<AccountWithBanks[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingAccount, setEditingAccount] = useState<EditingAccount | null>(null)
  const [revealing, setRevealing] = useState<string | null>(null)
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

  async function fetchPan(id: string): Promise<string | null> {
    if (revealed[id]) return revealed[id]
    const { data, error } = await supabase.functions.invoke<{ pan: string }>('reveal-pan', {
      body: { demat_id: id },
    })
    if (error || !data) return null
    setRevealed((r) => ({ ...r, [id]: data.pan }))
    return data.pan
  }

  async function revealPan(id: string) {
    setRevealing(id)
    await fetchPan(id)
    setRevealing(null)
  }

  async function startEdit(a: AccountWithBanks) {
    setRevealing(a.id)
    const pan = await fetchPan(a.id)
    setRevealing(null)
    if (!pan) {
      alert("Couldn't reveal PAN — can't edit without it.")
      return
    }
    setShowAddForm(false)
    setEditingAccount({
      id: a.id,
      holderName: a.holder_name,
      phoneDigits: a.phone_e164.replace(/^\+91/, ''),
      pan,
      dematAccountNo: a.dp_client_id ?? '',
    })
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            Demat accounts
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {accounts.length} registered
          </p>
        </div>
        <button
          onClick={() => {
            setEditingAccount(null)
            setShowAddForm((s) => !s)
          }}
          className="btn-primary"
        >
          {showAddForm ? 'Cancel' : '+ Add account'}
        </button>
      </div>

      {showAddForm && (
        <AccountForm
          onCancel={() => setShowAddForm(false)}
          onDone={() => {
            setShowAddForm(false)
            load()
          }}
        />
      )}

      {editingAccount && (
        <AccountForm
          existing={editingAccount}
          onCancel={() => setEditingAccount(null)}
          onDone={() => {
            setEditingAccount(null)
            load()
          }}
        />
      )}

      {loading ? (
        <InlineSpinner />
      ) : (
        <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
          {accounts.map((a) => (
            <div key={a.id} className="p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                    {a.holder_name}
                  </p>
                  <p className="break-words text-sm" style={{ color: 'var(--ink-muted)' }}>
                    {a.phone_e164}
                    {a.dp_client_id && ` · Demat a/c ${a.dp_client_id}`} ·{' '}
                    <span className="font-mono" style={{ color: 'var(--ink-secondary)' }}>
                      {revealed[a.id] ?? a.pan_masked}
                    </span>
                    {!revealed[a.id] && (
                      <button
                        onClick={() => revealPan(a.id)}
                        disabled={revealing === a.id}
                        className="link-accent ml-2 text-sm font-medium disabled:opacity-50"
                      >
                        {revealing === a.id ? 'Revealing…' : 'Reveal PAN'}
                      </button>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-3">
                  {!a.linked_user_id && <span className="badge badge-neutral">not invited</span>}
                  <button
                    onClick={() => startEdit(a)}
                    disabled={revealing === a.id}
                    className="link-accent text-xs font-medium disabled:opacity-50"
                  >
                    Edit
                  </button>
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
                      {[b.account_holder_name, b.bank_name, b.upi_id].filter(Boolean).join(' · ') || 'Bank account'}
                      {b.is_default && ' (default)'}
                      <button
                        onClick={() => deleteBank(b.id)}
                        aria-label="Remove bank/UPI account"
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

const PHONE_RE = /^[0-9]{10}$/
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/

interface BankRow {
  holderName: string
  upi: string
  bankName: string
}

function emptyBankRow(): BankRow {
  return { holderName: '', upi: '', bankName: '' }
}

function AccountForm({
  existing,
  onCancel,
  onDone,
}: {
  existing?: EditingAccount
  onCancel: () => void
  onDone: () => void
}) {
  const [holderName, setHolderName] = useState(existing?.holderName ?? '')
  const [phoneDigits, setPhoneDigits] = useState(existing?.phoneDigits ?? '')
  const [pan, setPan] = useState(existing?.pan ?? '')
  const [dematAccountNo, setDematAccountNo] = useState(existing?.dematAccountNo ?? '')
  const [bankRows, setBankRows] = useState<BankRow[]>([emptyBankRow()])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const phoneValid = PHONE_RE.test(phoneDigits)
  const panValid = PAN_RE.test(pan)

  function updateBankRow(i: number, patch: Partial<BankRow>) {
    setBankRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  function addBankRow() {
    setBankRows((rows) => [...rows, emptyBankRow()])
  }

  function removeBankRow(i: number) {
    setBankRows((rows) => rows.filter((_, idx) => idx !== i))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (!phoneValid) {
      setError('Phone number must be exactly 10 digits.')
      return
    }
    if (!panValid) {
      setError('PAN must be in the format ABCPD1234E (5 letters, 4 digits, 1 letter).')
      return
    }

    setSubmitting(true)
    const { data, error: fnError } = await supabase.functions.invoke<{ id?: string; error?: string }>(
      'add-demat',
      {
        body: {
          demat_id: existing?.id,
          holder_name: holderName,
          phone_digits: phoneDigits,
          pan,
          dp_client_id: dematAccountNo || null,
        },
      },
    )

    if (fnError || !data?.id) {
      setSubmitting(false)
      setError(await describeFunctionError(fnError, data))
      return
    }
    const dematId = data.id

    const rowsToSave = bankRows.filter((r) => r.holderName.trim() && r.upi.trim())
    if (rowsToSave.length > 0) {
      const { error: bankError } = await supabase.from('bank_accounts').insert(
        rowsToSave.map((r, i) => ({
          demat_id: dematId,
          account_holder_name: r.holderName.trim(),
          upi_id: r.upi.trim(),
          bank_name: r.bankName.trim() || null,
          is_default: i === 0,
        })),
      )
      if (bankError) {
        setSubmitting(false)
        setError(bankError.message)
        return
      }
    }

    setSubmitting(false)
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} className="card flex flex-col gap-5 p-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Holder name">
          <input required value={holderName} onChange={(e) => setHolderName(e.target.value)} className="input" />
        </Field>
        <Field label="Phone number" hint="10 digits, no country code">
          <div className="flex items-center gap-2">
            <span
              className="rounded-md border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--ink-muted)' }}
            >
              +91
            </span>
            <input
              required
              inputMode="numeric"
              maxLength={10}
              value={phoneDigits}
              onChange={(e) => setPhoneDigits(e.target.value.replace(/[^0-9]/g, ''))}
              className="input"
              placeholder="9876543210"
            />
          </div>
          {phoneDigits.length > 0 && !phoneValid && (
            <p className="mt-1 text-xs" style={{ color: 'var(--critical)' }}>
              Must be exactly 10 digits.
            </p>
          )}
        </Field>
        <Field label="PAN" hint="5 letters, 4 digits, 1 letter">
          <input
            required
            maxLength={10}
            value={pan}
            onChange={(e) => setPan(e.target.value.toUpperCase())}
            className="input font-mono"
            placeholder="ABCPD1234E"
          />
          {pan.length > 0 && !panValid && (
            <p className="mt-1 text-xs" style={{ color: 'var(--critical)' }}>
              e.g. ABCPD1234E — 5 letters, 4 digits, 1 letter.
            </p>
          )}
        </Field>
        <Field label="Demat account no.">
          <input
            required
            value={dematAccountNo}
            onChange={(e) => setDematAccountNo(e.target.value)}
            className="input"
          />
        </Field>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
          Bank / UPI accounts
          <span className="ml-2 text-xs font-normal" style={{ color: 'var(--ink-muted)' }}>
            optional — add one or more
          </span>
        </p>
        <div className="space-y-3">
          {bankRows.map((row, i) => (
            <div key={i} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
              <Field label="Account holder name">
                <input
                  value={row.holderName}
                  onChange={(e) => updateBankRow(i, { holderName: e.target.value })}
                  className="input"
                />
              </Field>
              <Field label="UPI ID">
                <input
                  value={row.upi}
                  onChange={(e) => updateBankRow(i, { upi: e.target.value })}
                  placeholder="name@bank"
                  className="input"
                />
              </Field>
              <Field label="Bank" hint="optional">
                <input
                  value={row.bankName}
                  onChange={(e) => updateBankRow(i, { bankName: e.target.value })}
                  className="input"
                />
              </Field>
              {bankRows.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeBankRow(i)}
                  className="btn-secondary h-fit"
                  aria-label="Remove this bank/UPI row"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
        <button type="button" onClick={addBankRow} className="link-accent mt-3 text-sm font-medium">
          + Add another bank/UPI account
        </button>
      </div>

      {error && <p className="badge badge-critical w-fit">{error}</p>}

      <div className="flex gap-2">
        <button type="submit" disabled={submitting} className="btn-primary flex-1 py-2.5">
          {submitting ? 'Saving…' : existing ? 'Save changes' : 'Save account'}
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
