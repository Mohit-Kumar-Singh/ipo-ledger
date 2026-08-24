import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { showToast } from '../lib/toast'
import { confirmDialog } from '../lib/confirmDialog'
import type { BankAccount, DematAccount } from '../types/database'

// Moved off Profile's own "Linked accounts" card (which used to show this
// list inline) onto its own page, same treatment Accounts/PAN access log
// just got — a full page reached by tapping a nav card reads better on
// phone than an ever-growing stack of inline sections. Content/logic here
// is unchanged from before, only the surrounding page chrome is new.
export function LinkedAccountsPage() {
  const { session, profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const queryClient = useQueryClient()
  const [unlinkingDematId, setUnlinkingDematId] = useState<string | null>(null)
  const [unlinkingBankId, setUnlinkingBankId] = useState<string | null>(null)

  interface LinkedAccountsData {
    linkedDemat: Pick<DematAccount, 'id' | 'holder_name'>[]
    linkedBank: Pick<BankAccount, 'id' | 'account_holder_name' | 'upi_id'>[]
  }
  const linkedAccountsQueryKey = ['my-linked-accounts', session?.user.id ?? null] as const
  const linkedAccountsQuery = useQuery<LinkedAccountsData>({
    queryKey: linkedAccountsQueryKey,
    queryFn: async () => {
      const [dematRes, bankRes] = await Promise.all([
        supabase.from('demat_accounts').select('id, holder_name').eq('linked_user_id', session!.user.id),
        supabase.from('bank_accounts').select('id, account_holder_name, upi_id').eq('linked_user_id', session!.user.id),
      ])
      return {
        linkedDemat: (dematRes.data ?? []) as Pick<DematAccount, 'id' | 'holder_name'>[],
        linkedBank: (bankRes.data ?? []) as Pick<BankAccount, 'id' | 'account_holder_name' | 'upi_id'>[],
      }
    },
    enabled: !!session,
  })
  const linkedDemat = linkedAccountsQuery.data?.linkedDemat ?? []
  const linkedBank = linkedAccountsQuery.data?.linkedBank ?? []
  function loadLinkedAccounts() {
    queryClient.invalidateQueries({ queryKey: linkedAccountsQueryKey })
  }

  async function unlinkDemat(id: string) {
    if (!(await confirmDialog('Unlink this account? An admin can re-link it later from the Users page.'))) return
    setUnlinkingDematId(id)
    const { error } = await supabase.rpc('unlink_demat_account', { p_demat_id: id })
    setUnlinkingDematId(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    loadLinkedAccounts()
  }

  async function unlinkBank(id: string) {
    if (!(await confirmDialog('Unlink this bank/UPI account? An admin can re-link it later from the Users page.'))) return
    setUnlinkingBankId(id)
    const { error } = await supabase.rpc('unlink_bank_account', { p_bank_account_id: id })
    setUnlinkingBankId(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    loadLinkedAccounts()
  }

  const combinedLinked = [
    ...linkedDemat.map((d) => ({
      id: d.id,
      kind: 'demat' as const,
      name: d.holder_name,
      onUnlink: () => unlinkDemat(d.id),
      unlinking: unlinkingDematId === d.id,
    })),
    ...linkedBank.map((b) => ({
      id: b.id,
      kind: 'bank' as const,
      name: b.account_holder_name ?? b.upi_id ?? 'Bank/UPI account',
      onUnlink: () => unlinkBank(b.id),
      unlinking: unlinkingBankId === b.id,
    })),
  ]

  return (
    <div className="mx-auto max-w-md space-y-4 lg:max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Linked accounts
        </h1>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          Demat and bank/UPI accounts linked to your login.
        </p>
      </div>

      <div className="card animate-page-in overflow-hidden">
        {combinedLinked.length === 0 ? (
          <p className="p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            No linked accounts yet — ask an admin to link one from the Users page.
          </p>
        ) : (
          combinedLinked.map((a) => (
            <div
              key={`${a.kind}-${a.id}`}
              className="flex items-center gap-3 border-t px-4 py-2.5 first:border-t-0"
              style={{ borderColor: 'var(--border)' }}
            >
              <span
                className={`icon-badge icon-badge-${a.kind === 'demat' ? 'info' : 'good'} shrink-0 text-xs font-bold`}
                style={{ width: '2rem', height: '2rem', borderRadius: '0.5rem' }}
              >
                {a.kind === 'demat' ? 'D' : 'B'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                  {a.name}
                </p>
                <p className="text-xs capitalize" style={{ color: 'var(--ink-muted)' }}>
                  {a.kind === 'demat' ? 'demat' : 'bank / UPI'}
                </p>
              </div>
              <button
                onClick={a.onUnlink}
                disabled={a.unlinking}
                className="shrink-0 text-xs font-medium hover:underline disabled:opacity-50"
                style={{ color: 'var(--critical)' }}
              >
                {a.unlinking ? 'Unlinking…' : 'Unlink'}
              </button>
            </div>
          ))
        )}
        {isAdmin && (
          <Link
            to="/users"
            className="flex w-full items-center justify-center gap-1.5 border-t py-3 text-sm font-medium transition-colors hover:bg-[var(--hover-surface)]"
            style={{ borderColor: 'var(--border)', color: 'var(--accent)' }}
          >
            Manage on the Users page
          </Link>
        )}
      </div>
    </div>
  )
}
