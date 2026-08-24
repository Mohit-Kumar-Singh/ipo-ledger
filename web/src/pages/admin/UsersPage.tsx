import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircleIcon, LawIcon, PersonIcon } from '@primer/octicons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { useDematAccounts, useBankAccounts, queryKeys } from '../../lib/queries'
import { showToast } from '../../lib/toast'
import { confirmDialog } from '../../lib/confirmDialog'
import type { BankAccount, DematAccount, Profile } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

// Module-level, not `?? []` inline — a fresh array literal on every render
// (while profilesQuery.data is still undefined) is a new reference each
// time, which defeats the `rows` useMemo below (its `members` dependency
// would never be seen as unchanged).
const EMPTY_PROFILES: Profile[] = []

// Replaces the old self-service "search by name/last-4, request, admin
// approves" flow (removed from ProfilePage) — that flow required a member to
// already know which account to search for and get PAN/UPI proof right, all
// before an admin ever looked at it. This inverts it: every new signup shows
// up here immediately (name, join date), and linking demat/bank accounts to
// them is a direct admin action, no request/approval round-trip. A single
// person can be linked to a demat account (account holder), a bank/UPI
// account (funder), or both at once — same underlying linked_user_id columns
// AccountsPage/BankAccountsPage already used for their own per-account
// "Link to member" controls, just organized per-PERSON here instead of
// per-account, so "is this person set up yet, and as what" is one glance
// instead of hunting across two other pages.
export function UsersPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const queryClient = useQueryClient()
  // This page's whole point is showing every member's name/phone/linked
  // accounts in one roster — real information exposure if a non-admin ever
  // landed here (via direct URL, not just the nav link), unlike
  // BankAccountsPage/AccountsPage where a member only ever sees accounts RLS
  // already scopes to them. The nav entry is admin-only too (AppShell), this
  // is the second layer for anyone who navigates here directly. Placed before
  // the data hooks below — no reason to even fetch the roster for someone who
  // can't see it.
  const dematQuery = useDematAccounts(isAdmin)
  const bankQuery = useBankAccounts(isAdmin)
  const demat = useMemo(() => dematQuery.data ?? [], [dematQuery.data])
  const banks = useMemo(() => bankQuery.data ?? [], [bankQuery.data])

  const profilesQuery = useQuery<Profile[]>({
    queryKey: ['profiles-members'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('role', 'member')
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as Profile[]
    },
    enabled: isAdmin,
  })
  const members = profilesQuery.data ?? EMPTY_PROFILES
  const loading = profilesQuery.isPending || dematQuery.isPending || bankQuery.isPending

  const [busyId, setBusyId] = useState<string | null>(null)

  const unlinkedDemat = useMemo(() => demat.filter((d) => !d.linked_user_id), [demat])
  const unlinkedBank = useMemo(() => banks.filter((b) => !b.linked_user_id), [banks])

  async function refreshAccounts() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.dematAccounts }),
      queryClient.invalidateQueries({ queryKey: queryKeys.bankAccounts }),
    ])
  }

  async function linkDemat(userId: string, dematId: string) {
    setBusyId(`${userId}-${dematId}`)
    const { error } = await supabase.from('demat_accounts').update({ linked_user_id: userId }).eq('id', dematId)
    setBusyId(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    await refreshAccounts()
  }

  async function unlinkDemat(dematId: string, holderName: string) {
    if (!(await confirmDialog(`Unlink ${holderName}'s demat account from this user?`))) return
    setBusyId(dematId)
    const { error } = await supabase.from('demat_accounts').update({ linked_user_id: null }).eq('id', dematId)
    setBusyId(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    await refreshAccounts()
  }

  async function linkBank(userId: string, bankId: string) {
    setBusyId(`${userId}-${bankId}`)
    const { error } = await supabase.from('bank_accounts').update({ linked_user_id: userId }).eq('id', bankId)
    setBusyId(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    await refreshAccounts()
  }

  async function unlinkBank(bankId: string, label: string) {
    if (!(await confirmDialog(`Unlink ${label} from this user?`))) return
    setBusyId(bankId)
    const { error } = await supabase.from('bank_accounts').update({ linked_user_id: null }).eq('id', bankId)
    setBusyId(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    await refreshAccounts()
  }

  const rows = useMemo(
    () =>
      members.map((profile) => ({
        profile,
        demat: demat.filter((d) => d.linked_user_id === profile.id),
        bank: banks.filter((b) => b.linked_user_id === profile.id),
      })),
    [members, demat, banks],
  )

  const newUsers = rows.filter((r) => r.demat.length === 0 && r.bank.length === 0)
  const funders = rows.filter((r) => r.bank.length > 0)
  const holders = rows.filter((r) => r.demat.length > 0)

  const rowProps = { unlinkedDemat, unlinkedBank, busyId, linkDemat, unlinkDemat, linkBank, unlinkBank }

  if (!isAdmin) {
    return (
      <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
        This page is for admins only.
      </p>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Users
        </h1>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          {members.length} signed up · {newUsers.length} not yet linked to anything
        </p>
      </div>

      {loading ? (
        <InlineSpinner />
      ) : members.length === 0 ? (
        <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
          No users have signed up yet.
        </p>
      ) : (
        <>
          <UserSection
            title="New — not yet linked"
            hint="just signed up; link them to a demat account (account holder), a bank/UPI account (funder), or both"
            rows={newUsers}
            emptyText="Nobody waiting — every signed-up user is linked to at least one account."
            {...rowProps}
          />
          <UserSection
            title="Funders"
            hint="linked to a bank/UPI account"
            rows={funders}
            emptyText="No funders linked yet."
            {...rowProps}
          />
          <UserSection
            title="Account holders"
            hint="linked to a demat account"
            rows={holders}
            emptyText="No account holders linked yet."
            {...rowProps}
          />
        </>
      )}
    </div>
  )
}

interface RowActions {
  unlinkedDemat: DematAccount[]
  unlinkedBank: BankAccount[]
  busyId: string | null
  linkDemat: (userId: string, dematId: string) => void
  unlinkDemat: (dematId: string, holderName: string) => void
  linkBank: (userId: string, bankId: string) => void
  unlinkBank: (bankId: string, label: string) => void
}

function UserSection({
  title,
  hint,
  rows,
  emptyText,
  ...actions
}: {
  title: string
  hint: string
  rows: { profile: Profile; demat: DematAccount[]; bank: BankAccount[] }[]
  emptyText: string
} & RowActions) {
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          {title}
        </h2>
        <span className="badge badge-neutral">{rows.length}</span>
        <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
          {hint}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="card p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
          {emptyText}
        </p>
      ) : (
        <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
          {rows.map((r) => (
            <UserRow key={r.profile.id} {...r} {...actions} />
          ))}
        </div>
      )}
    </section>
  )
}

function UserRow({
  profile,
  demat,
  bank,
  unlinkedDemat,
  unlinkedBank,
  busyId,
  linkDemat,
  unlinkDemat,
  linkBank,
  unlinkBank,
}: { profile: Profile; demat: DematAccount[]; bank: BankAccount[] } & RowActions) {
  return (
    <div className="stagger-item flex flex-wrap items-start justify-between gap-3 p-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            style={{ background: 'linear-gradient(135deg, var(--violet), var(--accent))', color: 'white' }}
          >
            {(profile.full_name || '?')
              .split(' ')
              .map((p) => p[0])
              .slice(0, 2)
              .join('')
              .toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
              {profile.full_name}
            </p>
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              Joined {new Date(profile.created_at).toLocaleDateString()}
              {profile.phone_e164 ? ` · ${profile.phone_e164}` : ''}
            </p>
          </div>
        </div>

        {(demat.length > 0 || bank.length > 0) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {demat.map((d) => (
              <span key={d.id} className="badge badge-info gap-1.5">
                <PersonIcon size={11} /> {d.holder_name}
                <button
                  onClick={() => unlinkDemat(d.id, d.holder_name)}
                  disabled={busyId === d.id}
                  className="font-semibold disabled:opacity-50"
                  style={{ color: 'var(--critical)' }}
                >
                  ×
                </button>
              </span>
            ))}
            {bank.map((b) => (
              <span key={b.id} className="badge badge-good gap-1.5">
                <LawIcon size={11} /> {b.account_holder_name ?? b.upi_id ?? 'Bank/UPI account'}
                <button
                  onClick={() => unlinkBank(b.id, b.account_holder_name ?? b.upi_id ?? 'this account')}
                  disabled={busyId === b.id}
                  className="font-semibold disabled:opacity-50"
                  style={{ color: 'var(--critical)' }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {unlinkedDemat.length > 0 && (
          <select
            value=""
            disabled={busyId?.startsWith(`${profile.id}-`) ?? false}
            onChange={(e) => e.target.value && linkDemat(profile.id, e.target.value)}
            className="input h-7 w-auto text-xs"
            aria-label={`Link ${profile.full_name} to a demat account`}
          >
            <option value="">Link to demat account…</option>
            {unlinkedDemat.map((d) => (
              <option key={d.id} value={d.id}>
                {d.holder_name}
              </option>
            ))}
          </select>
        )}
        {unlinkedBank.length > 0 && (
          <select
            value=""
            disabled={busyId?.startsWith(`${profile.id}-`) ?? false}
            onChange={(e) => e.target.value && linkBank(profile.id, e.target.value)}
            className="input h-7 w-auto text-xs"
            aria-label={`Link ${profile.full_name} to a funder UPI account`}
          >
            <option value="">Link to funder (UPI)…</option>
            {unlinkedBank.map((b) => (
              <option key={b.id} value={b.id}>
                {b.account_holder_name ?? b.upi_id ?? 'Bank/UPI account'}
              </option>
            ))}
          </select>
        )}
        {demat.length > 0 && bank.length > 0 && (
          <span className="badge badge-violet gap-1" title="Linked as both a funder and an account holder">
            <CheckCircleIcon size={11} /> both
          </span>
        )}
      </div>
    </div>
  )
}
