import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Landmark } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { BankAccount } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

interface EditingBank {
  id: string
  holderName: string
  upi: string
  bankName: string
  phoneDigits: string
  isDefault: boolean
}

export function BankAccountsPage() {
  const { session, profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [banks, setBanks] = useState<BankAccount[]>([])
  const [dematPhoneByName, setDematPhoneByName] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<EditingBank | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('bank_accounts')
      .select('*')
      .order('is_default', { ascending: false })
      .order('account_holder_name')
    setBanks((data ?? []) as BankAccount[])
    setLoading(false)
  }

  useEffect(() => {
    load()
    // So the "Account holder name" field can suggest names already used for
    // a demat account (instead of retyping and risking a mismatched
    // spelling), and picking one can auto-fill their phone number too.
    supabase
      .from('demat_accounts')
      .select('holder_name, phone_e164')
      .order('holder_name')
      .then(({ data }) => {
        const map: Record<string, string> = {}
        for (const d of data ?? []) map[d.holder_name as string] = (d.phone_e164 as string) ?? ''
        setDematPhoneByName(map)
      })
  }, [])

  function startEdit(b: BankAccount) {
    setShowForm(false)
    setEditing({
      id: b.id,
      holderName: b.account_holder_name ?? '',
      upi: b.upi_id ?? '',
      bankName: b.bank_name ?? '',
      phoneDigits: b.phone_e164?.replace(/^\+91/, '') ?? '',
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

  function toggleSelected(id: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    setSelected((s) => (s.size === banks.length ? new Set() : new Set(banks.map((b) => b.id))))
  }

  async function bulkDelete() {
    if (selected.size === 0) return
    if (!window.confirm(`Remove ${selected.size} bank/UPI account(s)?`)) return
    const { error } = await supabase.from('bank_accounts').delete().in('id', Array.from(selected))
    if (error) {
      alert(error.message)
      return
    }
    setSelected(new Set())
    load()
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            Bank / UPI accounts
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {banks.length} saved — pick any of these for any demat account when you apply, so one bank/UPI can be
            reused across holders and one holder can use several.
          </p>
        </div>
        <button
          onClick={() => {
            setEditing(null)
            setShowForm((s) => !s)
          }}
          className="btn-primary"
        >
          {showForm ? 'Cancel' : '+ Add bank/UPI account'}
        </button>
      </div>

      {showForm && session && (
        <BankForm
          userId={session.user.id}
          isAdmin={isAdmin}
          dematPhoneByName={dematPhoneByName}
          onCancel={() => setShowForm(false)}
          onDone={() => {
            setShowForm(false)
            load()
          }}
        />
      )}

      {editing && session && (
        <BankForm
          userId={session.user.id}
          isAdmin={isAdmin}
          dematPhoneByName={dematPhoneByName}
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
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--ink-secondary)' }}>
              <input
                type="checkbox"
                checked={selected.size > 0 && selected.size === banks.length}
                ref={(el) => {
                  if (el) el.indeterminate = selected.size > 0 && selected.size < banks.length
                }}
                onChange={toggleSelectAll}
              />
              Select all
            </label>
            {selected.size > 0 && (
              <button
                onClick={bulkDelete}
                className="text-sm font-medium hover:underline"
                style={{ color: 'var(--critical)' }}
              >
                Delete {selected.size} selected
              </button>
            )}
          </div>
          <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
          {banks.map((b) => (
            <div key={b.id} className="stagger-item flex flex-wrap items-center justify-between gap-2 p-4">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <input
                  type="checkbox"
                  checked={selected.has(b.id)}
                  onChange={() => toggleSelected(b.id)}
                  aria-label={`Select ${b.account_holder_name}`}
                />
                <div className="icon-badge icon-badge-good shrink-0" style={{ width: '2.25rem', height: '2.25rem' }}>
                  <Landmark size={16} strokeWidth={2} />
                </div>
                <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                  {b.account_holder_name}
                </span>
                {b.upi_id && (
                  <span className="break-all" style={{ color: 'var(--ink-muted)' }}>
                    {b.upi_id}
                  </span>
                )}
                {b.bank_name && <span style={{ color: 'var(--ink-muted)' }}>{b.bank_name}</span>}
                {b.phone_e164 && <span style={{ color: 'var(--ink-muted)' }}>{b.phone_e164}</span>}
                {b.is_default && <span className="badge badge-info">default</span>}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {isAdmin || b.linked_user_id === session?.user.id ? (
                  <>
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
                  </>
                ) : (
                  // Not one this member created themselves — reachable only via
                  // their own linked demat account, i.e. admin added it on their
                  // behalf. They get narrow edit rights (UPI ID only), not the
                  // full form, and no delete.
                  <UpiOnlyEdit bank={b} onSaved={load} />
                )}
              </div>
            </div>
          ))}
          </div>
        </>
      )}
    </div>
  )
}

function BankForm({
  userId,
  isAdmin,
  existing,
  dematPhoneByName,
  onCancel,
  onDone,
}: {
  userId: string
  isAdmin: boolean
  existing?: EditingBank
  dematPhoneByName: Record<string, string>
  onCancel: () => void
  onDone: () => void
}) {
  const [holderName, setHolderName] = useState(existing?.holderName ?? '')
  const [upi, setUpi] = useState(existing?.upi ?? '')
  const [bankName, setBankName] = useState(existing?.bankName ?? '')
  const [phoneDigits, setPhoneDigits] = useState(existing?.phoneDigits ?? '')
  const [isDefault, setIsDefault] = useState(existing?.isDefault ?? false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Picking a name that already has a demat account fills in their phone
  // too, since it's almost always the same number — never overwrites a
  // phone the admin already typed in themselves.
  function handleHolderNameChange(name: string) {
    setHolderName(name)
    const knownPhone = dematPhoneByName[name]
    if (knownPhone && !phoneDigits) {
      setPhoneDigits(knownPhone.replace(/^\+91/, ''))
    }
  }

  const phoneValid = /^[0-9]{10}$/.test(phoneDigits)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (!phoneValid) {
      setError('Phone number is required and must be exactly 10 digits.')
      return
    }

    setSubmitting(true)

    const payload = {
      account_holder_name: holderName.trim(),
      upi_id: upi.trim() || null,
      bank_name: bankName.trim() || null,
      phone_e164: phoneDigits ? `+91${phoneDigits}` : null,
      is_default: isDefault,
    }

    // linked_user_id is only set on creation, and only for a member adding
    // their own bank/UPI account (self-service ownership for RLS purposes).
    // When admin adds one, it's on someone else's behalf, not a claim of
    // ownership — so it's left unlinked rather than defaulting to admin.
    const { error } = existing
      ? await supabase.from('bank_accounts').update(payload).eq('id', existing.id)
      : await supabase.from('bank_accounts').insert({ ...payload, linked_user_id: isAdmin ? null : userId })

    setSubmitting(false)
    if (error) {
      setError(error.message)
      return
    }
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} className="card grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
      <Field label="Account holder name" hint="pick an existing demat holder, or type a new name">
        <input
          required
          list="demat-holder-names"
          value={holderName}
          onChange={(e) => handleHolderNameChange(e.target.value)}
          className="input"
        />
        <datalist id="demat-holder-names">
          {Object.keys(dematPhoneByName).map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Field>
      <Field label="UPI ID" hint="optional">
        <input value={upi} onChange={(e) => setUpi(e.target.value)} placeholder="name@bank" className="input" />
      </Field>
      <Field label="Bank" hint="optional">
        <input value={bankName} onChange={(e) => setBankName(e.target.value)} className="input" />
      </Field>
      <Field label="Phone number" hint="sends the applied message to this holder too">
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
        {!phoneValid && phoneDigits.length > 0 && (
          <p className="mt-1 text-xs" style={{ color: 'var(--critical)' }}>
            Must be exactly 10 digits.
          </p>
        )}
      </Field>
      <label className="col-span-1 flex items-center gap-2 text-sm sm:col-span-2" style={{ color: 'var(--ink-secondary)' }}>
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        Use as default
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

function UpiOnlyEdit({ bank, onSaved }: { bank: BankAccount; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [upi, setUpi] = useState(bank.upi_id ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    const { error } = await supabase.rpc('update_own_bank_upi', {
      p_bank_account_id: bank.id,
      p_upi_id: upi.trim() || null,
    })
    setSaving(false)
    if (error) {
      setError(error.message)
      return
    }
    setEditing(false)
    onSaved()
  }

  if (!editing) {
    return (
      <button onClick={() => setEditing(true)} className="link-accent text-xs font-medium">
        Edit UPI
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <input
        value={upi}
        onChange={(e) => setUpi(e.target.value)}
        placeholder="name@bank"
        className="input h-8 w-36 text-xs"
      />
      <button onClick={save} disabled={saving} className="link-accent text-xs font-medium disabled:opacity-50">
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button onClick={() => setEditing(false)} className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
        Cancel
      </button>
      {error && (
        <span className="text-xs" style={{ color: 'var(--critical)' }}>
          {error}
        </span>
      )}
    </div>
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
