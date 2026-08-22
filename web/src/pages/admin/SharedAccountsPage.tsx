import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PeopleIcon, LinkIcon } from '@primer/octicons-react'
import { supabase } from '../../lib/supabase'
import { useDematAccounts, queryKeys } from '../../lib/queries'
import { showToast } from '../../lib/toast'
import { confirmDialog } from '../../lib/confirmDialog'
import type { AccountManager, AccountManagerCaseType, DematAccount, Profile } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

// Admin-only page — gated by the parent route the same way every other
// admin-* page under /src/pages/admin is (App.tsx's route tree), not by any
// isAdmin check inside this file, matching the project's "no client-side
// admin gating on reads" convention (RLS is the only real boundary; a
// non-admin querying account_managers/demat_accounts here would just get
// nothing back per p_account_managers_admin/p_demat_member_manager).
//
// Two lists, one per real case (see migration 0079's own comment for the
// full reasoning):
//   CASE_1 — person provided the account, you fund it; they get a cut
//   (already covering their own tax) and a separate funder still gets a
//   share, e.g. 40% / 30% / 30% (manager / funder / you).
//   CASE_2 — person provided AND funds the account themselves; they get a
//   bigger cut covering both roles combined, e.g. 70% / 30% (manager / you).
export function SharedAccountsPage() {
  const queryClient = useQueryClient()
  // Shared cache (lib/queries.ts) — demat_accounts is also read in full by
  // Accounts/Applications/BankAccounts/Dashboard; this page's own mutations
  // (assign/unassign a manager) write demat_accounts rows, so they need to
  // invalidate the shared cache, not just update page-local state.
  const dematAccountsQuery = useDematAccounts()
  const accounts = useMemo(
    () => [...(dematAccountsQuery.data ?? [])].sort((a, b) => a.holder_name.localeCompare(b.holder_name)),
    [dematAccountsQuery.data],
  )
  const [showForm, setShowForm] = useState<AccountManagerCaseType | null>(null)
  const [editing, setEditing] = useState<AccountManager | null>(null)

  // managers/linkableMembers are page-local (account_managers and the
  // unfiltered profiles list aren't read anywhere else) — only the
  // demat_accounts half of what used to be one Promise.all moves to the
  // shared cache. Was a manual load() run once on mount (managersLoaded
  // flag standing in for a loading state) — one useQuery instead, so
  // revisiting this page within staleTime renders the previous lists
  // instantly rather than a spinner over data that was already on screen.
  interface SharedAccountsLocalData {
    managers: AccountManager[]
    linkableMembers: Profile[]
  }
  const sharedAccountsLocalQueryKey = ['shared-accounts-local'] as const
  const localQuery = useQuery<SharedAccountsLocalData>({
    queryKey: sharedAccountsLocalQueryKey,
    queryFn: async () => {
      const [managersRes, membersRes] = await Promise.all([
        supabase.from('account_managers').select('*').order('full_name'),
        supabase.from('profiles').select('*'),
      ])
      return {
        managers: (managersRes.data ?? []) as AccountManager[],
        linkableMembers: (membersRes.data ?? []) as Profile[],
      }
    },
  })
  const managers = localQuery.data?.managers ?? []
  const linkableMembers = localQuery.data?.linkableMembers ?? []
  const loading = dematAccountsQuery.isPending || localQuery.isPending

  function load() {
    queryClient.invalidateQueries({ queryKey: queryKeys.dematAccounts })
    queryClient.invalidateQueries({ queryKey: sharedAccountsLocalQueryKey })
  }

  async function deleteManager(id: string) {
    if (
      !(await confirmDialog('Remove this person? Accounts assigned to them go back to unassigned, not deleted.', {
        tone: 'critical',
        confirmLabel: 'Remove',
      }))
    )
      return
    // Unassign first — account_manager_id has a plain FK with no ON DELETE
    // rule, so deleting a still-referenced manager would otherwise fail with
    // a foreign-key violation instead of cleanly freeing those accounts.
    await supabase.from('demat_accounts').update({ account_manager_id: null }).eq('account_manager_id', id)
    const { error } = await supabase.from('account_managers').delete().eq('id', id)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    load()
  }

  async function assign(managerId: string, demat: DematAccount, cutPercent: number) {
    // Copies the manager's cut onto the account's own profit_share_percent
    // at assignment time (migration 0079's design) — every existing
    // computeProfitSplit call site already reads that column, so nothing
    // downstream needs to know about account_managers at all just to get
    // the money math right.
    const { error } = await supabase
      .from('demat_accounts')
      .update({ account_manager_id: managerId, profit_share_percent: cutPercent })
      .eq('id', demat.id)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    load()
  }

  async function unassign(demat: DematAccount) {
    const { error } = await supabase.from('demat_accounts').update({ account_manager_id: null }).eq('id', demat.id)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    load()
  }

  const case1 = managers.filter((m) => m.case_type === 'CASE_1')
  const case2 = managers.filter((m) => m.case_type === 'CASE_2')

  if (loading) {
    return (
      <div className="space-y-5">
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Shared accounts
        </h1>
        <InlineSpinner />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Shared accounts
        </h1>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          Accounts sourced by someone else, who gets a cut of the profit and the applied/allotted messages for them.
        </p>
      </div>

      <ManagerSection
        title="Case 1 — they provide the account, you fund it"
        hint="They get a cut (already covering their own tax); a separate funder still gets a share; you keep the rest."
        caseType="CASE_1"
        managers={case1}
        accounts={accounts}
        linkableMembers={linkableMembers}
        showForm={showForm === 'CASE_1'}
        onToggleForm={() => setShowForm((s) => (s === 'CASE_1' ? null : 'CASE_1'))}
        editing={editing?.case_type === 'CASE_1' ? editing : null}
        onEdit={setEditing}
        onDelete={deleteManager}
        onAssign={assign}
        onUnassign={unassign}
        onDone={() => {
          setShowForm(null)
          setEditing(null)
          load()
        }}
      />

      <ManagerSection
        title="Case 2 — they provide AND fund the account themselves"
        hint="They get a bigger cut covering both the account-holder and funder roles combined; you keep the rest."
        caseType="CASE_2"
        managers={case2}
        accounts={accounts}
        linkableMembers={linkableMembers}
        showForm={showForm === 'CASE_2'}
        onToggleForm={() => setShowForm((s) => (s === 'CASE_2' ? null : 'CASE_2'))}
        editing={editing?.case_type === 'CASE_2' ? editing : null}
        onEdit={setEditing}
        onDelete={deleteManager}
        onAssign={assign}
        onUnassign={unassign}
        onDone={() => {
          setShowForm(null)
          setEditing(null)
          load()
        }}
      />
    </div>
  )
}

function ManagerSection({
  title,
  hint,
  caseType,
  managers,
  accounts,
  linkableMembers,
  showForm,
  onToggleForm,
  editing,
  onEdit,
  onDelete,
  onAssign,
  onUnassign,
  onDone,
}: {
  title: string
  hint: string
  caseType: AccountManagerCaseType
  managers: AccountManager[]
  accounts: DematAccount[]
  linkableMembers: Profile[]
  showForm: boolean
  onToggleForm: () => void
  editing: AccountManager | null
  onEdit: (m: AccountManager | null) => void
  onDelete: (id: string) => void
  onAssign: (managerId: string, demat: DematAccount, cutPercent: number) => void
  onUnassign: (demat: DematAccount) => void
  onDone: () => void
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            {title}
          </h2>
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            {hint}
          </p>
        </div>
        <button
          onClick={() => {
            onEdit(null)
            onToggleForm()
          }}
          className="btn-secondary shrink-0"
        >
          {showForm ? 'Cancel' : '+ Add person'}
        </button>
      </div>

      {showForm && (
        <ManagerForm caseType={caseType} linkableMembers={linkableMembers} onCancel={onToggleForm} onDone={onDone} />
      )}
      {editing && (
        <ManagerForm
          caseType={caseType}
          linkableMembers={linkableMembers}
          existing={editing}
          onCancel={() => onEdit(null)}
          onDone={onDone}
        />
      )}

      {managers.length === 0 ? (
        <p className="card p-6 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
          Nobody added yet.
        </p>
      ) : (
        <div className="space-y-3">
          {managers.map((m) => (
            <ManagerCard
              key={m.id}
              manager={m}
              accounts={accounts}
              linkableMembers={linkableMembers}
              onEdit={() => onEdit(m)}
              onDelete={() => onDelete(m.id)}
              onAssign={onAssign}
              onUnassign={onUnassign}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function ManagerCard({
  manager,
  accounts,
  linkableMembers,
  onEdit,
  onDelete,
  onAssign,
  onUnassign,
}: {
  manager: AccountManager
  accounts: DematAccount[]
  linkableMembers: Profile[]
  onEdit: () => void
  onDelete: () => void
  onAssign: (managerId: string, demat: DematAccount, cutPercent: number) => void
  onUnassign: (demat: DematAccount) => void
}) {
  const assigned = useMemo(() => accounts.filter((a) => a.account_manager_id === manager.id), [accounts, manager.id])
  const unassignable = useMemo(
    () => accounts.filter((a) => a.account_manager_id !== manager.id && a.is_active),
    [accounts, manager.id],
  )
  const linkedName = linkableMembers.find((p) => p.id === manager.linked_user_id)?.full_name

  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="icon-badge icon-badge-good shrink-0" style={{ width: '2.25rem', height: '2.25rem' }}>
            <PeopleIcon size={16} />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                {manager.full_name}
              </span>
              <span className="badge badge-info">{manager.cut_percent}% cut</span>
              {manager.tax_percent != null && (
                <span className="badge" style={{ color: 'var(--ink-muted)' }}>
                  incl. {manager.tax_percent}% tax
                </span>
              )}
              {!manager.is_active && <span className="badge badge-critical">inactive</span>}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
              {manager.phone_e164 && <span>{manager.phone_e164}</span>}
              {manager.upi_id && <span>{manager.upi_id}</span>}
              {linkedName ? (
                <span className="flex items-center gap-1" style={{ color: 'var(--good)' }}>
                  <LinkIcon size={11} /> linked to {linkedName}
                </span>
              ) : (
                <span>not linked to a portal login yet</span>
              )}
            </div>
            {manager.notes && (
              <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                {manager.notes}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button onClick={onEdit} className="link-accent text-xs font-medium">
            Edit
          </button>
          <button onClick={onDelete} className="text-xs font-medium hover:underline" style={{ color: 'var(--critical)' }}>
            Remove
          </button>
        </div>
      </div>

      <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <p className="mb-1.5 text-xs font-medium" style={{ color: 'var(--ink-secondary)' }}>
          {assigned.length} account{assigned.length === 1 ? '' : 's'} assigned
        </p>
        {assigned.length > 0 && (
          <ul className="mb-2 space-y-1">
            {assigned.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 text-xs">
                <span style={{ color: 'var(--ink-primary)' }}>{a.holder_name}</span>
                <button onClick={() => onUnassign(a)} className="link-accent font-medium">
                  Unassign
                </button>
              </li>
            ))}
          </ul>
        )}
        {unassignable.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const demat = accounts.find((a) => a.id === e.target.value)
              if (demat) onAssign(manager.id, demat, manager.cut_percent)
            }}
            className="input h-8 w-full text-xs sm:w-64"
          >
            <option value="">+ Assign an account…</option>
            {unassignable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.holder_name}
                {a.account_manager_id ? ' (currently with someone else)' : ''}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  )
}

function ManagerForm({
  caseType,
  existing,
  linkableMembers,
  onCancel,
  onDone,
}: {
  caseType: AccountManagerCaseType
  existing?: AccountManager
  linkableMembers: Profile[]
  onCancel: () => void
  onDone: () => void
}) {
  const [fullName, setFullName] = useState(existing?.full_name ?? '')
  const [phoneDigits, setPhoneDigits] = useState(existing?.phone_e164?.replace(/^\+91/, '') ?? '')
  const [upi, setUpi] = useState(existing?.upi_id ?? '')
  const [cutPercent, setCutPercent] = useState(String(existing?.cut_percent ?? (caseType === 'CASE_1' ? 40 : 70)))
  const [taxPercent, setTaxPercent] = useState(existing?.tax_percent != null ? String(existing.tax_percent) : '')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [linkedUserId, setLinkedUserId] = useState(existing?.linked_user_id ?? '')
  const [isActive, setIsActive] = useState(existing?.is_active ?? true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const cut = Number(cutPercent)
    if (!fullName.trim() || Number.isNaN(cut) || cut < 0 || cut > 100) {
      setError('Name and a cut % between 0 and 100 are required.')
      return
    }
    const tax = taxPercent.trim() === '' ? null : Number(taxPercent)
    if (tax != null && (Number.isNaN(tax) || tax < 0 || tax > 100)) {
      setError('Tax % must be between 0 and 100, or left blank.')
      return
    }

    setSubmitting(true)
    const payload = {
      full_name: fullName.trim(),
      phone_e164: phoneDigits ? `+91${phoneDigits}` : null,
      upi_id: upi.trim() || null,
      case_type: caseType,
      cut_percent: cut,
      tax_percent: tax,
      notes: notes.trim() || null,
      linked_user_id: linkedUserId || null,
      is_active: isActive,
    }
    const { error } = existing
      ? await supabase.from('account_managers').update(payload).eq('id', existing.id)
      : await supabase.from('account_managers').insert(payload)
    setSubmitting(false)
    if (error) {
      setError(error.message)
      return
    }
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} className="card grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
      <Field label="Name">
        <input required value={fullName} onChange={(e) => setFullName(e.target.value)} className="input" />
      </Field>
      <Field label="Cut %" hint={caseType === 'CASE_1' ? 'e.g. 40' : 'e.g. 70'}>
        <input
          required
          inputMode="decimal"
          value={cutPercent}
          onChange={(e) => setCutPercent(e.target.value)}
          className="input"
        />
      </Field>
      <Field label="Tax % within that cut" hint="optional — shown separately, not deducted again">
        <input inputMode="decimal" value={taxPercent} onChange={(e) => setTaxPercent(e.target.value)} className="input" />
      </Field>
      <Field label="Phone number" hint="applied/allotted messages go here">
        <div className="flex items-center gap-2">
          <span
            className="rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--ink-muted)' }}
          >
            +91
          </span>
          <input
            inputMode="numeric"
            maxLength={10}
            value={phoneDigits}
            onChange={(e) => setPhoneDigits(e.target.value.replace(/[^0-9]/g, ''))}
            className="input"
            placeholder="9876543210"
          />
        </div>
      </Field>
      <Field label="UPI ID" hint="optional, for sending them their cut">
        <input value={upi} onChange={(e) => setUpi(e.target.value)} placeholder="name@bank" className="input" />
      </Field>
      {linkableMembers.length > 0 && (
        <Field label="Link to portal login" hint="lets them see their own accounts after signing in">
          <select value={linkedUserId} onChange={(e) => setLinkedUserId(e.target.value)} className="input">
            <option value="">Not linked</option>
            {linkableMembers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Notes" hint="optional">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className="input" />
      </Field>
      {existing && (
        <label className="col-span-1 flex items-center gap-2 text-sm sm:col-span-2" style={{ color: 'var(--ink-secondary)' }}>
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Active
        </label>
      )}

      {error && <p className="badge badge-critical col-span-1 w-fit sm:col-span-2">{error}</p>}

      <div className="col-span-1 flex gap-2 sm:col-span-2">
        <button type="submit" disabled={submitting} className="btn-primary flex-1 py-2.5">
          {submitting ? 'Saving…' : existing ? 'Save changes' : 'Save person'}
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
