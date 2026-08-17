import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CreditCardIcon,
  LawIcon,
  ArchiveIcon,
  SignOutIcon,
  DeviceMobileIcon,
  PeopleIcon,
  SearchIcon,
  ShieldCheckIcon,
  PersonIcon,
  XIcon,
} from '@primer/octicons-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { showToast } from '../lib/toast'
import { confirmDialog } from '../lib/confirmDialog'
import { ThemeToggle } from '../components/ThemeToggle'
import { Logo } from '../components/Logo'
import { InfoTooltip } from '../components/HoverCard'
import { AccountsPage } from './admin/AccountsPage'
import { SellInstructionPdfsSection } from './admin/SellInstructionPdfs'
import { ArchivedApplicationsCard } from './admin/ArchivedApplicationsCard'
import type {
  BankAccount,
  BankLinkRequest,
  DematAccount,
  DematLinkRequest,
  LinkRequestStatus,
  Profile,
} from '../types/database'

const PHONE_RE = /^[0-9]{10}$/
const PAN_RE = /^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/

interface SearchResult {
  id: string
  holder_name: string
  phone_masked: string
}

interface BankSearchResult {
  id: string
  account_holder_name: string | null
  bank_name: string | null
  last4_masked: string | null
  upi_domain_masked: string | null
}

type MyRequestRow = DematLinkRequest & { demat_accounts: Pick<DematAccount, 'holder_name'> | null }
type MyBankRequestRow = BankLinkRequest & { bank_accounts: Pick<BankAccount, 'account_holder_name'> | null }

const requestStatusBadge: Record<LinkRequestStatus, string> = {
  PENDING: 'badge-warning',
  APPROVED: 'badge-good',
  REJECTED: 'badge-critical',
}

// Unifies demat and bank/UPI link requests into one review list — same
// decision RPC either way, just a different target account. Moved here
// from the Dashboard (was a permanent tile + section there; now review
// happens on Profile instead, with a toast — see ToastHost — replacing
// the tile as the "something needs attention" signal).
interface PendingReviewRequest {
  id: string
  kind: 'demat' | 'bank'
  requestedAt: string
  requesterName: string
  targetName: string
}

export function ProfilePage() {
  const { session, profile, refreshProfile, signOut } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [pendingReview, setPendingReview] = useState<PendingReviewRequest[]>([])
  const [loadingReview, setLoadingReview] = useState(true)
  const [decidingId, setDecidingId] = useState<string | null>(null)
  const [fullName, setFullName] = useState(profile?.full_name ?? '')
  const [phoneDigits, setPhoneDigits] = useState(profile?.phone_e164?.replace(/^\+91/, '') ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const [pan, setPan] = useState('')
  const [editingPan, setEditingPan] = useState(false)
  const [panSubmitting, setPanSubmitting] = useState(false)
  const [panResult, setPanResult] = useState<{ tone: 'good' | 'warning' | 'critical'; message: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchedOnce, setSearchedOnce] = useState(false)
  const [requestingId, setRequestingId] = useState<string | null>(null)
  const [requestResult, setRequestResult] = useState<{ tone: 'good' | 'warning' | 'critical'; message: string } | null>(null)
  const [myRequests, setMyRequests] = useState<MyRequestRow[]>([])
  const [loadingRequests, setLoadingRequests] = useState(true)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const [linkedDemat, setLinkedDemat] = useState<Pick<DematAccount, 'id' | 'holder_name'>[]>([])
  const [linkedBank, setLinkedBank] = useState<Pick<BankAccount, 'id' | 'account_holder_name' | 'upi_id'>[]>([])
  const [unlinkingDematId, setUnlinkingDematId] = useState<string | null>(null)
  const [unlinkingBankId, setUnlinkingBankId] = useState<string | null>(null)

  const [bankSearchQuery, setBankSearchQuery] = useState('')
  const [bankSecret, setBankSecret] = useState('')
  const [searchingBank, setSearchingBank] = useState(false)
  const [bankSearchResults, setBankSearchResults] = useState<BankSearchResult[]>([])
  const [bankSearchedOnce, setBankSearchedOnce] = useState(false)
  const [requestingBankId, setRequestingBankId] = useState<string | null>(null)
  const [bankRequestResult, setBankRequestResult] = useState<{ tone: 'good' | 'warning' | 'critical'; message: string } | null>(null)
  const [myBankRequests, setMyBankRequests] = useState<MyBankRequestRow[]>([])
  const [loadingBankRequests, setLoadingBankRequests] = useState(true)
  const [cancellingBankId, setCancellingBankId] = useState<string | null>(null)

  // Which "Your details" row (if any) is inline-editable right now — name
  // and phone used to share one always-open form; each field is now its
  // own independent edit/save/cancel, matching PAN's existing pattern below.
  const [editingField, setEditingField] = useState<'name' | 'phone' | null>(null)
  // The "+ Link an account" bottom sheet — Demat/Bank tabs inside it reuse
  // the exact same search/request state and handlers as before, just
  // re-hosted in a modal instead of two always-visible stacked forms.
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetTab, setSheetTab] = useState<'demat' | 'bank'>('demat')

  useEffect(() => {
    setFullName(profile?.full_name ?? '')
    setPhoneDigits(profile?.phone_e164?.replace(/^\+91/, '') ?? '')
  }, [profile?.full_name, profile?.phone_e164])

  async function loadMyRequests() {
    setLoadingRequests(true)
    // No more demat_accounts(holder_name) embed — RLS no longer grants a
    // requesting member row access to an account before it's approved
    // (migration 0066, closing the same "whole row for a name" gap 0034
    // already fixed on the funder path). Resolve just the name instead.
    const { data, error } = await supabase
      .from('demat_link_requests')
      .select('*')
      .order('requested_at', { ascending: false })
    if (error) {
      showToast(`Couldn't load your link requests: ${error.message}`, 'critical')
      setLoadingRequests(false)
      return
    }
    const rows = (data ?? []) as DematLinkRequest[]
    const ids = Array.from(new Set(rows.map((r) => r.demat_id)))
    const nameById = new Map<string, string>()
    if (ids.length > 0) {
      const { data: resolved } = await supabase.rpc('resolve_demat_holder_names', { p_ids: ids })
      for (const r of (resolved ?? []) as { id: string; holder_name: string }[]) nameById.set(r.id, r.holder_name)
    }
    setMyRequests(rows.map((r) => ({ ...r, demat_accounts: nameById.has(r.demat_id) ? { holder_name: nameById.get(r.demat_id)! } : null })))
    setLoadingRequests(false)
  }

  async function loadMyBankRequests() {
    setLoadingBankRequests(true)
    const { data, error } = await supabase
      .from('bank_link_requests')
      .select('*')
      .order('requested_at', { ascending: false })
    if (error) {
      showToast(`Couldn't load your bank link requests: ${error.message}`, 'critical')
      setLoadingBankRequests(false)
      return
    }
    const bankRows = (data ?? []) as BankLinkRequest[]
    const bankIds = Array.from(new Set(bankRows.map((r) => r.bank_account_id)))
    const bankNameById = new Map<string, string>()
    if (bankIds.length > 0) {
      const { data: resolvedBanks } = await supabase.rpc('resolve_bank_holder_names', { p_ids: bankIds })
      for (const r of (resolvedBanks ?? []) as { id: string; account_holder_name: string | null }[]) {
        if (r.account_holder_name) bankNameById.set(r.id, r.account_holder_name)
      }
    }
    setMyBankRequests(
      bankRows.map((r) => ({
        ...r,
        bank_accounts: bankNameById.has(r.bank_account_id) ? { account_holder_name: bankNameById.get(r.bank_account_id)! } : null,
      })),
    )
    setLoadingBankRequests(false)
  }

  async function loadLinkedAccounts() {
    if (!session) return
    const [dematRes, bankRes] = await Promise.all([
      supabase.from('demat_accounts').select('id, holder_name').eq('linked_user_id', session.user.id),
      supabase.from('bank_accounts').select('id, account_holder_name, upi_id').eq('linked_user_id', session.user.id),
    ])
    setLinkedDemat((dematRes.data ?? []) as Pick<DematAccount, 'id' | 'holder_name'>[])
    setLinkedBank((bankRes.data ?? []) as Pick<BankAccount, 'id' | 'account_holder_name' | 'upi_id'>[])
  }

  async function loadPendingReview() {
    setLoadingReview(true)
    const [dematRes, bankRes] = await Promise.all([
      supabase
        .from('demat_link_requests')
        .select('*, profiles!member_id(full_name), demat_accounts(holder_name)')
        .eq('status', 'PENDING')
        .order('requested_at', { ascending: false }),
      supabase
        .from('bank_link_requests')
        .select('*, profiles!member_id(full_name), bank_accounts(account_holder_name)')
        .eq('status', 'PENDING')
        .order('requested_at', { ascending: false }),
    ])
    type DematRow = DematLinkRequest & { profiles: Pick<Profile, 'full_name'> | null; demat_accounts: Pick<DematAccount, 'holder_name'> | null }
    type BankRow = BankLinkRequest & { profiles: Pick<Profile, 'full_name'> | null; bank_accounts: Pick<BankAccount, 'account_holder_name'> | null }
    const unified: PendingReviewRequest[] = [
      ...((dematRes.data ?? []) as DematRow[]).map((r) => ({
        id: r.id,
        kind: 'demat' as const,
        requestedAt: r.requested_at,
        requesterName: r.profiles?.full_name ?? 'Unknown',
        targetName: r.demat_accounts?.holder_name ?? 'an account',
      })),
      ...((bankRes.data ?? []) as BankRow[]).map((r) => ({
        id: r.id,
        kind: 'bank' as const,
        requestedAt: r.requested_at,
        requesterName: r.profiles?.full_name ?? 'Unknown',
        targetName: r.bank_accounts?.account_holder_name ?? 'a bank/UPI account',
      })),
    ].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    setPendingReview(unified)
    setLoadingReview(false)
  }

  async function decideLinkRequest(kind: 'demat' | 'bank', id: string, approve: boolean) {
    setDecidingId(id)
    const rpcName = kind === 'demat' ? 'decide_demat_link_request' : 'decide_bank_link_request'
    const { error } = await supabase.rpc(rpcName, { p_request_id: id, p_approve: approve })
    setDecidingId(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    setPendingReview((rows) => rows.filter((r) => r.id !== id))
  }

  useEffect(() => {
    loadMyRequests()
    loadMyBankRequests()
    loadLinkedAccounts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id])

  useEffect(() => {
    if (!isAdmin) return
    loadPendingReview()
    // Realtime so a request approved/rejected/cancelled elsewhere (or a
    // brand new one arriving) doesn't need a manual refresh to disappear/
    // appear here — both tables are already in the supabase_realtime
    // publication (see CLAUDE.md).
    const channel = supabase
      .channel('profile-pending-review')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'demat_link_requests' }, () => loadPendingReview())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bank_link_requests' }, () => loadPendingReview())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])

  const phoneValid = phoneDigits.length === 0 || PHONE_RE.test(phoneDigits)

  async function handleSavePan(e: FormEvent) {
    e.preventDefault()
    setPanResult(null)

    const normalized = pan.trim().toUpperCase()
    if (!PAN_RE.test(normalized)) {
      setPanResult({ tone: 'critical', message: 'PAN must be in the format ABCPD1234E (5 letters, 4 digits, 1 letter).' })
      return
    }

    setPanSubmitting(true)
    const { error } = await supabase.rpc('set_self_pan_hash', { p_pan: normalized })
    setPanSubmitting(false)
    if (error) {
      setPanResult({ tone: 'critical', message: error.message })
      return
    }
    setPanResult({ tone: 'good', message: 'PAN saved — you can now request to link a matching account below.' })
    setPan('')
    setEditingPan(false)
    await refreshProfile()
  }

  async function handleSearch(e: FormEvent) {
    e.preventDefault()
    setSearching(true)
    setRequestResult(null)
    const { data, error } = await supabase.rpc('search_unlinked_demat_accounts', { p_query: searchQuery.trim() })
    setSearching(false)
    setSearchedOnce(true)
    if (error) {
      setRequestResult({ tone: 'critical', message: error.message })
      setSearchResults([])
      return
    }
    setSearchResults((data ?? []) as SearchResult[])
  }

  async function handleRequestLink(dematId: string) {
    setRequestingId(dematId)
    setRequestResult(null)
    const { data, error } = await supabase.rpc('request_demat_link', { p_demat_id: dematId })
    setRequestingId(null)
    if (error) {
      setRequestResult({ tone: 'critical', message: error.message })
      return
    }

    const status = (data as { status: string } | null)?.status
    const outcomes: Record<string, { tone: 'good' | 'warning' | 'critical'; message: string }> = {
      requested: { tone: 'good', message: 'Requested — the admin will review it.' },
      no_pan_on_file: { tone: 'warning', message: 'Save your PAN above first.' },
      pan_mismatch: { tone: 'warning', message: "That account's PAN doesn't match yours on file." },
      already_pending: { tone: 'warning', message: 'You already have a pending request for this account.' },
      already_linked: { tone: 'warning', message: 'Someone already linked to this account.' },
      not_found: { tone: 'critical', message: 'Account not found.' },
    }
    setRequestResult(outcomes[status ?? ''] ?? { tone: 'critical', message: 'Something went wrong.' })
    if (status === 'requested') {
      setSearchResults((r) => r.filter((x) => x.id !== dematId))
      await loadMyRequests()
    }
  }

  async function cancelRequest(id: string) {
    setCancellingId(id)
    const { error } = await supabase.from('demat_link_requests').delete().eq('id', id)
    setCancellingId(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    loadMyRequests()
  }

  async function unlinkDemat(id: string) {
    if (!(await confirmDialog('Unlink this account? You can request to re-link it later.'))) return
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
    if (!(await confirmDialog('Unlink this bank/UPI account? You can request to re-link it later.'))) return
    setUnlinkingBankId(id)
    const { error } = await supabase.rpc('unlink_bank_account', { p_bank_account_id: id })
    setUnlinkingBankId(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    loadLinkedAccounts()
  }

  async function handleSearchBank(e: FormEvent) {
    e.preventDefault()
    setSearchingBank(true)
    setBankRequestResult(null)
    const { data, error } = await supabase.rpc('search_unlinked_bank_accounts', { p_query: bankSearchQuery.trim() })
    setSearchingBank(false)
    setBankSearchedOnce(true)
    if (error) {
      setBankRequestResult({ tone: 'critical', message: error.message })
      setBankSearchResults([])
      return
    }
    setBankSearchResults((data ?? []) as BankSearchResult[])
  }

  async function handleRequestBankLink(bankAccountId: string) {
    if (!bankSecret.trim()) {
      setBankRequestResult({ tone: 'warning', message: 'Enter the UPI ID (or last 4 digits) to prove it’s yours.' })
      return
    }
    setRequestingBankId(bankAccountId)
    setBankRequestResult(null)
    const { data, error } = await supabase.rpc('request_bank_link', {
      p_bank_account_id: bankAccountId,
      p_secret: bankSecret.trim(),
    })
    setRequestingBankId(null)
    if (error) {
      setBankRequestResult({ tone: 'critical', message: error.message })
      return
    }

    const status = (data as { status: string } | null)?.status
    const outcomes: Record<string, { tone: 'good' | 'warning' | 'critical'; message: string }> = {
      requested: { tone: 'good', message: 'Requested — the admin will review it.' },
      no_secret: { tone: 'warning', message: 'Enter the UPI ID or last 4 digits first.' },
      secret_mismatch: { tone: 'warning', message: "That doesn't match this account's UPI ID or last 4 digits." },
      already_pending: { tone: 'warning', message: 'You already have a pending request for this account.' },
      already_linked: { tone: 'warning', message: 'Someone already linked to this account.' },
      not_found: { tone: 'critical', message: 'Account not found.' },
    }
    setBankRequestResult(outcomes[status ?? ''] ?? { tone: 'critical', message: 'Something went wrong.' })
    if (status === 'requested') {
      setBankSearchResults((r) => r.filter((x) => x.id !== bankAccountId))
      setBankSecret('')
      await loadMyBankRequests()
    }
  }

  async function cancelBankRequest(id: string) {
    setCancellingBankId(id)
    const { error } = await supabase.from('bank_link_requests').delete().eq('id', id)
    setCancellingBankId(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    loadMyBankRequests()
  }

  // Shared by saveName/savePhone below — same update_own_profile RPC the
  // old combined form used (line ~276 originally), just called from two
  // independent save actions instead of one. Whichever field ISN'T being
  // saved right now is passed through unchanged (fullName/phoneDigits both
  // already mirror the persisted profile value except while their own row
  // is actively being edited — see the sync effect above and
  // cancelFieldEdit below, which resets both on cancel).
  async function updateProfile(nextName: string, nextPhoneDigits: string) {
    setSubmitting(true)
    const { error } = await supabase.rpc('update_own_profile', {
      p_full_name: nextName,
      p_phone_e164: nextPhoneDigits ? `+91${nextPhoneDigits}` : null,
    })
    setSubmitting(false)
    if (error) {
      setError(error.message)
      return false
    }
    await refreshProfile()
    return true
  }

  function startEditName() {
    setFullName(profile?.full_name ?? '')
    setError(null)
    setEditingField('name')
  }
  function startEditPhone() {
    setPhoneDigits(profile?.phone_e164?.replace(/^\+91/, '') ?? '')
    setError(null)
    setEditingField('phone')
  }
  function cancelFieldEdit() {
    setFullName(profile?.full_name ?? '')
    setPhoneDigits(profile?.phone_e164?.replace(/^\+91/, '') ?? '')
    setError(null)
    setEditingField(null)
  }
  async function saveName() {
    const trimmed = fullName.trim()
    if (!trimmed) {
      setError('Name cannot be empty.')
      return
    }
    const ok = await updateProfile(trimmed, profile?.phone_e164?.replace(/^\+91/, '') ?? '')
    if (ok) {
      setEditingField(null)
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 2000)
    }
  }
  async function savePhone() {
    if (!phoneValid) {
      setError('Phone number must be exactly 10 digits, or left blank.')
      return
    }
    const ok = await updateProfile(profile?.full_name ?? fullName, phoneDigits)
    if (ok) {
      setEditingField(null)
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 2000)
    }
  }

  function openSheet() {
    setSheetOpen(true)
    setSheetTab('demat')
    setRequestResult(null)
    setBankRequestResult(null)
  }
  function closeSheet() {
    setSheetOpen(false)
  }

  // Merges demat + bank into one list each — same unification pattern
  // loadPendingReview already uses for the admin-side equivalent.
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
  const combinedRequests = [
    ...myRequests.map((r) => ({
      id: r.id,
      kind: 'demat' as const,
      targetName: r.demat_accounts?.holder_name ?? '—',
      requestedAt: r.requested_at,
      status: r.status,
      onCancel: () => cancelRequest(r.id),
      cancelling: cancellingId === r.id,
    })),
    ...myBankRequests.map((r) => ({
      id: r.id,
      kind: 'bank' as const,
      targetName: r.bank_accounts?.account_holder_name ?? '—',
      requestedAt: r.requested_at,
      status: r.status,
      onCancel: () => cancelBankRequest(r.id),
      cancelling: cancellingBankId === r.id,
    })),
  ].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))

  return (
    <div className="mx-auto max-w-md space-y-4 lg:max-w-2xl">
      {/* Page header — the "Profile" title is replaced by the full logo
          (icon+wordmark, sized for phone) since this is the one page that's
          always the first thing tapped from the bottom tab bar; the theme
          toggle sits in this same row instead of its own dedicated card
          further down. */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <Logo size={26} />
          <p className="mt-1 text-sm" style={{ color: 'var(--ink-muted)' }}>
            Your display name signs off the WhatsApp messages you send.
          </p>
        </div>
        <ThemeToggle iconOnly />
      </div>

      {/* Identity card — avatar/name/role/email unchanged, then three
          independently inline-editable rows (name, phone, PAN) instead of
          one combined name+phone form plus a separate PAN block. */}
      <div className="card animate-page-in p-4">
        <div className="flex items-center gap-3 border-b pb-3" style={{ borderColor: 'var(--border)' }}>
          <div
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-lg font-semibold"
            style={{ background: 'linear-gradient(135deg, var(--violet), var(--accent))', color: 'white' }}
          >
            {(profile?.full_name || '?')
              .split(' ')
              .map((p) => p[0])
              .slice(0, 2)
              .join('')
              .toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate font-semibold" style={{ color: 'var(--ink-primary)' }}>
                {profile?.full_name || 'Your name'}
              </p>
              <span className="badge badge-info shrink-0" style={{ textTransform: 'capitalize' }}>
                {profile?.role ?? 'member'}
              </span>
            </div>
            <p className="truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
              {session?.user.email ?? session?.user.phone ?? '—'}
            </p>
            <p className="text-[10px] lg:hidden" style={{ color: 'var(--ink-muted)' }}>
              v{__APP_VERSION__}
            </p>
          </div>
        </div>

        {justSaved && (
          <p className="pt-2 text-xs font-medium" style={{ color: 'var(--good)' }}>
            Saved ✓
          </p>
        )}

        {/* Full name row */}
        <div className="border-b" style={{ borderColor: 'var(--border)' }}>
          {editingField === 'name' ? (
            <div className="space-y-2 py-3">
              <label className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--ink-secondary)' }}>
                Full name
                <InfoTooltip text={`Shown in the sidebar, and used to sign messages — e.g. "— ${fullName.trim() || 'your name'}".`} />
              </label>
              <div className="flex items-center gap-2">
                <PersonIcon size={15} fill="var(--ink-muted)" />
                <input autoFocus required value={fullName} onChange={(e) => setFullName(e.target.value)} className="input" />
              </div>
              {error && (
                <p className="text-xs" style={{ color: 'var(--critical)' }}>
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-3">
                <button type="button" onClick={cancelFieldEdit} className="text-sm font-medium" style={{ color: 'var(--ink-muted)' }}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveName}
                  disabled={submitting}
                  className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50"
                >
                  {submitting ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={startEditName} className="flex w-full items-center gap-3 py-2.5 text-left">
              <div className="min-w-0 flex-1">
                <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                  Full name
                </p>
                <p className="truncate text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                  {fullName || '—'}
                </p>
              </div>
              <ChevronRightIcon size={16} fill="var(--ink-muted)" />
            </button>
          )}
        </div>

        {/* Phone row */}
        <div className="border-b" style={{ borderColor: 'var(--border)' }}>
          {editingField === 'phone' ? (
            <div className="space-y-2 py-3">
              <label className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--ink-secondary)' }}>
                Phone number
                <InfoTooltip text="Optional, 10 digits." />
              </label>
              <div className="flex items-center gap-2">
                <DeviceMobileIcon size={15} fill="var(--ink-muted)" />
                <span
                  className="rounded-md border px-3 py-2 text-sm"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--ink-muted)' }}
                >
                  +91
                </span>
                <input
                  autoFocus
                  inputMode="numeric"
                  maxLength={10}
                  value={phoneDigits}
                  onChange={(e) => setPhoneDigits(e.target.value.replace(/[^0-9]/g, ''))}
                  className="input"
                  placeholder="9876543210"
                />
              </div>
              {!phoneValid && (
                <p className="text-xs" style={{ color: 'var(--critical)' }}>
                  Must be exactly 10 digits.
                </p>
              )}
              {error && (
                <p className="text-xs" style={{ color: 'var(--critical)' }}>
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-3">
                <button type="button" onClick={cancelFieldEdit} className="text-sm font-medium" style={{ color: 'var(--ink-muted)' }}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={savePhone}
                  disabled={submitting}
                  className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50"
                >
                  {submitting ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={startEditPhone} className="flex w-full items-center gap-3 py-2.5 text-left">
              <div className="min-w-0 flex-1">
                <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                  Phone number
                </p>
                <p className="font-mono-ipo truncate text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                  {phoneDigits ? `+91 ${phoneDigits}` : 'Not set'}
                </p>
              </div>
              <ChevronRightIcon size={16} fill="var(--ink-muted)" />
            </button>
          )}
        </div>

        {/* PAN row — already independently editable, just restyled to match */}
        <form onSubmit={handleSavePan}>
          {editingPan || !profile?.self_pan_masked ? (
            <div className="space-y-2 py-3">
              <label className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--ink-secondary)' }}>
                Your PAN
                <InfoTooltip text="Save your PAN so it can be matched when you request to link a demat account. Self-attested — the admin still approves each link." />
              </label>
              <div className="flex items-center gap-2">
                <CreditCardIcon size={15} fill="var(--ink-muted)" />
                <input
                  value={pan}
                  onChange={(e) => setPan(e.target.value.toUpperCase())}
                  maxLength={10}
                  placeholder="ABCPD1234E"
                  className="input font-mono-ipo uppercase"
                />
              </div>
              {profile?.self_pan_hash && !profile?.self_pan_masked && (
                <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                  A PAN is already on file from before this showed a preview — save it again to see it below.
                </p>
              )}
              {panResult && <p className={`badge w-fit badge-${panResult.tone}`}>{panResult.message}</p>}
              <div className="flex justify-end gap-3">
                {profile?.self_pan_masked && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingPan(false)
                      setPan('')
                      setPanResult(null)
                    }}
                    className="text-sm font-medium"
                    style={{ color: 'var(--ink-muted)' }}
                  >
                    Cancel
                  </button>
                )}
                <button type="submit" disabled={panSubmitting || !pan} className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50">
                  {panSubmitting ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" onClick={() => setEditingPan(true)} className="flex w-full items-center gap-3 py-2.5 text-left">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                    Your PAN
                    <InfoTooltip text="Save your PAN so it can be matched when you request to link a demat account. Self-attested — the admin still approves each link." />
                  </p>
                  <p className="font-mono-ipo truncate text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                    {profile.self_pan_masked}
                  </p>
                </div>
                <ChevronRightIcon size={16} fill="var(--ink-muted)" />
              </button>
              {panResult && <p className={`badge w-fit badge-${panResult.tone}`}>{panResult.message}</p>}
            </>
          )}
        </form>
      </div>

      {/* Quick nav ("Explore") — destinations not on the bottom tab bar.
          IPOs dropped from this list — it's one tap away from the
          Dashboard already, no need to duplicate it here. Hidden at lg,
          where the sidebar already covers all of these. */}
      <div className="card animate-page-in overflow-hidden lg:hidden">
        <p className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--ink-muted)' }}>
          Explore
        </p>
        <nav className="flex flex-col p-1.5 pt-0.5">
          {[
            { to: '/bank-accounts', label: 'Bank / UPI accounts', desc: 'Manage funding sources', icon: LawIcon, tone: 'good', show: true },
            { to: '/payouts', label: 'Payouts', desc: 'Funding & payout ledger', icon: CreditCardIcon, tone: 'violet', show: isAdmin },
            { to: '/archives', label: 'Archives', desc: 'Closed IPO history', icon: ArchiveIcon, tone: 'neutral', show: true },
          ]
            .filter((l) => l.show)
            .map((l) => {
              const Icon = l.icon
              return (
                <Link
                  key={l.to}
                  to={l.to}
                  className="flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-[var(--hover-surface)]"
                >
                  <span className={`icon-badge icon-badge-${l.tone} shrink-0`} style={{ width: '2.25rem', height: '2.25rem', borderRadius: '0.6rem' }}>
                    <Icon size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {l.label}
                    </span>
                    <span className="block truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {l.desc}
                    </span>
                  </span>
                  <ChevronRightIcon size={16} fill="var(--ink-muted)" />
                </Link>
              )
            })}
        </nav>
      </div>

      {/* Linked accounts */}
      <div className="card animate-page-in overflow-hidden">
        <h2 className="px-4 pt-3 pb-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          Linked accounts
        </h2>
        {combinedLinked.length === 0 ? (
          <p className="px-4 pb-3 text-sm" style={{ color: 'var(--ink-muted)' }}>
            No linked accounts yet.
          </p>
        ) : (
          combinedLinked.map((a) => (
            <div
              key={`${a.kind}-${a.id}`}
              className="flex items-center gap-3 border-t px-4 py-2.5"
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
        <button
          type="button"
          onClick={openSheet}
          className="flex w-full items-center justify-center gap-1.5 border-t py-3 text-sm font-medium transition-colors hover:bg-[var(--hover-surface)]"
          style={{ borderColor: 'var(--border)', color: 'var(--accent)' }}
        >
          <span className="text-base leading-none">+</span> Link an account
        </button>
      </div>

      {/* Your requests — demat + bank merged into one list, same
          unification pattern loadPendingReview already uses below. */}
      <div className="card animate-page-in space-y-3 p-4">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          Your requests
        </h2>
        {loadingRequests || loadingBankRequests ? (
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            Loading…
          </p>
        ) : combinedRequests.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            No link requests yet.
          </p>
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {combinedRequests.map((r) => (
              <div key={`${r.kind}-${r.id}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
                    {r.targetName}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                    {r.kind === 'demat' ? 'Demat account' : 'Bank / UPI account'} · Requested{' '}
                    {new Date(r.requestedAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`badge ${requestStatusBadge[r.status]}`}>{r.status}</span>
                  {r.status === 'PENDING' && (
                    <button
                      onClick={r.onCancel}
                      disabled={r.cancelling}
                      aria-label="Cancel request"
                      className="rounded-lg p-1 transition-colors hover:bg-[var(--critical-tint)] disabled:opacity-50"
                      style={{ color: 'var(--critical)' }}
                    >
                      <XIcon size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pending approvals (admin) — unchanged loadPendingReview/decideLinkRequest, restyled heading only. */}
      {isAdmin && (
        <div className="card animate-page-in space-y-3 p-4">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
              Pending approvals
            </h2>
            {pendingReview.length > 0 && <span className="badge badge-warning">{pendingReview.length}</span>}
          </div>
          {loadingReview ? (
            <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
              Loading…
            </p>
          ) : pendingReview.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
              Nothing pending.
            </p>
          ) : (
            <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {pendingReview.map((r) => (
                <div key={`${r.kind}-${r.id}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {r.requesterName}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                      wants to link {r.targetName} <span className="badge badge-neutral ml-1">{r.kind}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-3">
                    <button
                      onClick={() => decideLinkRequest(r.kind, r.id, true)}
                      disabled={decidingId === r.id}
                      className="link-accent text-xs font-medium disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => decideLinkRequest(r.kind, r.id, false)}
                      disabled={decidingId === r.id}
                      className="text-xs font-medium hover:underline disabled:opacity-50"
                      style={{ color: 'var(--critical)' }}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* More — groups the secondary/occasional sections under one heading
          instead of four separate top-level cards; each keeps its own
          internal open/close state exactly as before. */}
      <div className="space-y-2">
        <p className="px-1 text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--ink-muted)' }}>
          More
        </p>
        <div className="space-y-2">
          <AccountsSection />
          {isAdmin && <PanAccessLogSection />}
          {/* Sell-instruction PDFs + archived applications sit last — rarely-
              touched references, collapsed by default. Archived is self-fetching
              and renders nothing when there's no archived history. */}
          {isAdmin && <SellInstructionPdfsSection />}
          <ArchivedApplicationsCard />
        </div>
      </div>

      <button
        type="button"
        onClick={signOut}
        className="flex w-full items-center justify-center gap-2 rounded-2xl border py-3 text-sm font-semibold"
        style={{ borderColor: 'var(--critical-tint)', background: 'var(--critical-tint)', color: 'var(--critical-text)' }}
      >
        <SignOutIcon size={16} fill="var(--critical-text)" />
        Sign out
      </button>

      {sheetOpen && (
        <LinkAccountSheet
          onClose={closeSheet}
          tab={sheetTab}
          setTab={setSheetTab}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          searching={searching}
          onSearch={handleSearch}
          requestResult={requestResult}
          searchedOnce={searchedOnce}
          searchResults={searchResults}
          requestingId={requestingId}
          onRequestLink={handleRequestLink}
          bankSearchQuery={bankSearchQuery}
          setBankSearchQuery={setBankSearchQuery}
          searchingBank={searchingBank}
          onSearchBank={handleSearchBank}
          bankRequestResult={bankRequestResult}
          bankSearchedOnce={bankSearchedOnce}
          bankSearchResults={bankSearchResults}
          bankSecret={bankSecret}
          setBankSecret={setBankSecret}
          requestingBankId={requestingBankId}
          onRequestBankLink={handleRequestBankLink}
        />
      )}
    </div>
  )
}

// Bottom sheet for "+ Link an account" — every piece of state/logic here is
// passed in from ProfilePage (the demat search/request state and the
// parallel bank search/request state both already existed as two
// always-visible stacked forms; this just re-hosts them behind a Demat/Bank
// tab toggle in a modal instead).
function LinkAccountSheet({
  onClose,
  tab,
  setTab,
  searchQuery,
  setSearchQuery,
  searching,
  onSearch,
  requestResult,
  searchedOnce,
  searchResults,
  requestingId,
  onRequestLink,
  bankSearchQuery,
  setBankSearchQuery,
  searchingBank,
  onSearchBank,
  bankRequestResult,
  bankSearchedOnce,
  bankSearchResults,
  bankSecret,
  setBankSecret,
  requestingBankId,
  onRequestBankLink,
}: {
  onClose: () => void
  tab: 'demat' | 'bank'
  setTab: (t: 'demat' | 'bank') => void
  searchQuery: string
  setSearchQuery: (v: string) => void
  searching: boolean
  onSearch: (e: FormEvent) => void
  requestResult: { tone: 'good' | 'warning' | 'critical'; message: string } | null
  searchedOnce: boolean
  searchResults: SearchResult[]
  requestingId: string | null
  onRequestLink: (id: string) => void
  bankSearchQuery: string
  setBankSearchQuery: (v: string) => void
  searchingBank: boolean
  onSearchBank: (e: FormEvent) => void
  bankRequestResult: { tone: 'good' | 'warning' | 'critical'; message: string } | null
  bankSearchedOnce: boolean
  bankSearchResults: BankSearchResult[]
  bankSecret: string
  setBankSecret: (v: string) => void
  requestingBankId: string | null
  onRequestBankLink: (id: string) => void
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onClose} />
      <div
        className="animate-page-in relative flex max-h-[80vh] w-full flex-col overflow-hidden rounded-t-3xl sm:max-w-md sm:rounded-3xl"
        style={{ background: 'var(--surface)' }}
      >
        <div className="flex justify-center pt-2.5 pb-1 sm:hidden">
          <div className="h-1 w-9 rounded-full" style={{ background: 'var(--border-strong)' }} />
        </div>
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
          <h2 className="text-base font-semibold" style={{ color: 'var(--ink-primary)' }}>
            Link an account
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-full"
            style={{ background: 'var(--hover-surface)' }}
          >
            <XIcon size={14} fill="var(--ink-secondary)" />
          </button>
        </div>

        <div className="px-4 pt-3">
          <div className="inline-flex rounded-full border p-1" style={{ borderColor: 'var(--border)', background: 'var(--page)' }}>
            <button
              type="button"
              onClick={() => setTab('demat')}
              className="rounded-full px-4 py-1.5 text-sm font-semibold transition-colors"
              style={tab === 'demat' ? { background: 'var(--surface)', color: 'var(--ink-primary)' } : { color: 'var(--ink-muted)' }}
            >
              Demat
            </button>
            <button
              type="button"
              onClick={() => setTab('bank')}
              className="rounded-full px-4 py-1.5 text-sm font-semibold transition-colors"
              style={tab === 'bank' ? { background: 'var(--surface)', color: 'var(--ink-primary)' } : { color: 'var(--ink-muted)' }}
            >
              Bank / UPI
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'demat' ? (
            <form onSubmit={onSearch} className="space-y-3">
              <div className="flex items-center gap-2">
                <SearchIcon size={15} fill="var(--ink-muted)" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Name or last 4 digits"
                  className="input"
                />
                <button type="submit" disabled={searching || !searchQuery.trim()} className="btn-secondary shrink-0 disabled:opacity-50">
                  {searching ? 'Searching…' : 'Search'}
                </button>
              </div>
              {requestResult && <p className={`badge w-fit badge-${requestResult.tone}`}>{requestResult.message}</p>}
              {searchedOnce && searchResults.length === 0 && (
                <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
                  No matching unlinked accounts.
                </p>
              )}
              {searchResults.length > 0 && (
                <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                  {searchResults.map((r) => (
                    <div key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                      <div>
                        <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                          {r.holder_name}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                          {r.phone_masked}
                        </p>
                      </div>
                      <button
                        onClick={() => onRequestLink(r.id)}
                        disabled={requestingId === r.id}
                        className="badge badge-info shrink-0 disabled:opacity-50"
                      >
                        {requestingId === r.id ? 'Requesting…' : 'Request'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </form>
          ) : (
            <form onSubmit={onSearchBank} className="space-y-3">
              <div className="flex items-center gap-2">
                <SearchIcon size={15} fill="var(--ink-muted)" />
                <input
                  value={bankSearchQuery}
                  onChange={(e) => setBankSearchQuery(e.target.value)}
                  placeholder="Name or last 4 digits"
                  className="input"
                />
                <button
                  type="submit"
                  disabled={searchingBank || !bankSearchQuery.trim()}
                  className="btn-secondary shrink-0 disabled:opacity-50"
                >
                  {searchingBank ? 'Searching…' : 'Search'}
                </button>
              </div>
              {bankRequestResult && <p className={`badge w-fit badge-${bankRequestResult.tone}`}>{bankRequestResult.message}</p>}
              {bankSearchedOnce && bankSearchResults.length === 0 && (
                <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
                  No matching unlinked bank/UPI accounts.
                </p>
              )}
              {bankSearchResults.length > 0 && (
                <>
                  <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
                    UPI ID or last 4 digits
                    <input
                      value={bankSecret}
                      onChange={(e) => setBankSecret(e.target.value)}
                      placeholder="name@bank or 1234"
                      className="input mt-1"
                    />
                  </label>
                  <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                    {bankSearchResults.map((r) => (
                      <div key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                        <div>
                          <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                            {r.account_holder_name ?? 'Bank/UPI account'}
                          </p>
                          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                            {[r.bank_name, r.last4_masked, r.upi_domain_masked].filter(Boolean).join(' · ')}
                          </p>
                        </div>
                        <button
                          onClick={() => onRequestBankLink(r.id)}
                          disabled={requestingBankId === r.id}
                          className="badge badge-info shrink-0 disabled:opacity-50"
                        >
                          {requestingBankId === r.id ? 'Requesting…' : 'Request'}
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

// Moved here from its own /accounts nav item — same AccountsPage component,
// same functionality (add/edit/link/reveal-PAN etc.), unchanged; just
// reached via a collapsible section at the bottom of Profile now instead of
// a dedicated sidebar entry. Collapsed by default since it's a secondary,
// occasional task from here, not the main reason someone's on this page.
function AccountsSection() {
  const [open, setOpen] = useState(false)
  return (
    <section className="card animate-page-in overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 p-4 text-left transition-colors hover:bg-[var(--hover-surface)]"
      >
        <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          <PeopleIcon size={16} fill="var(--accent)" />
          Accounts
        </span>
        <span
          className="inline-flex transition-transform duration-200"
          style={{ color: 'var(--ink-muted)', transform: open ? 'rotate(180deg)' : undefined }}
        >
          <ChevronDownIcon size={16} />
        </span>
      </button>
      {open && (
        <div className="border-t p-4" style={{ borderColor: 'var(--border)' }}>
          <AccountsPage />
        </div>
      )}
    </section>
  )
}

interface PanAccessLogRow {
  id: string
  demat_id: string
  accessed_by: string
  accessed_at: string
  is_self_reveal: boolean
  demat_accounts: { holder_name: string } | null
  profiles: { full_name: string } | null
}

// Local calendar day, not UTC — a reveal at 11pm IST is "today" to whoever's
// looking, even though its accessed_at timestamp may already have rolled
// into tomorrow in UTC.
function dayKeyFor(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Moved here from the deleted Settings page, unchanged — admin-only, still
// grouped by day and collapsible (most recent day open by default).
function PanAccessLogSection() {
  // Whole section collapsed by default now too — same card-with-chevron
  // shape as AccountsSection below, instead of always sitting open with
  // just its per-day groups collapsed underneath.
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<PanAccessLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())

  useEffect(() => {
    supabase
      .from('pan_access_log')
      .select('*, demat_accounts(holder_name), profiles(full_name)')
      .order('accessed_at', { ascending: false })
      .limit(200)
      .then(({ data }) => {
        const loaded = (data ?? []) as unknown as PanAccessLogRow[]
        setRows(loaded)
        if (loaded.length > 0) setOpenDays(new Set([dayKeyFor(loaded[0].accessed_at)]))
        setLoading(false)
      })
  }, [])

  const dayGroups = useMemo(() => {
    const groups = new Map<string, PanAccessLogRow[]>()
    for (const r of rows) {
      const key = dayKeyFor(r.accessed_at)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(r)
    }
    return Array.from(groups.entries())
  }, [rows])

  function toggleDay(key: string) {
    setOpenDays((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    // overflow-hidden, not visible — the (i) tooltip on the heading below
    // is an absolutely-positioned popup that needs to float OVER this
    // card's own edge; overflow-hidden here clipped it down to an
    // unreadable sliver instead of letting it show. AccountsSection above
    // keeps overflow-hidden since it has no popup content to clip.
    <section className="card animate-page-in overflow-visible">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 p-4 text-left transition-colors hover:bg-[var(--hover-surface)]"
      >
        <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          <ShieldCheckIcon size={16} fill="var(--violet)" />
          PAN access log
          <InfoTooltip text={`Every time a PAN is decrypted (Accounts/Allotment board "Reveal PAN"), it's logged here — who, whose PAN, and when. Grouped by day, most recent first.`} />
        </span>
        <span
          className="inline-flex transition-transform duration-200"
          style={{ color: 'var(--ink-muted)', transform: open ? 'rotate(180deg)' : undefined }}
        >
          <ChevronDownIcon size={16} />
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t p-4" style={{ borderColor: 'var(--border)' }}>
          {loading ? (
            <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
              Loading…
            </p>
          ) : dayGroups.length === 0 ? (
            <p className="p-4 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
              No PAN reveals logged yet.
            </p>
          ) : (
            <div className="space-y-2">
              {dayGroups.map(([day, dayRows]) => {
                const dayOpen = openDays.has(day)
                return (
                  <div key={day} className="rounded-md border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
                    <button
                      type="button"
                      onClick={() => toggleDay(day)}
                      className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm font-medium transition-colors hover:bg-[var(--hover-surface)]"
                      style={{ color: 'var(--ink-primary)' }}
                    >
                      <span>
                        {dayOpen ? '▾' : '▸'}{' '}
                        {new Date(dayRows[0].accessed_at).toLocaleDateString(undefined, {
                          weekday: 'short',
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </span>
                      <span className="badge badge-neutral shrink-0">{dayRows.length}</span>
                    </button>
                    {dayOpen && (
                      <table className="w-full text-sm">
                        <thead style={{ background: 'var(--page)', color: 'var(--ink-muted)' }} className="text-left">
                          <tr>
                            <th className="px-4 py-2 font-medium">When</th>
                            <th className="px-4 py-2 font-medium">PAN of</th>
                            <th className="px-4 py-2 font-medium">Accessed by</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y border-t" style={{ borderColor: 'var(--border)' }}>
                          {dayRows.map((r) => (
                            <tr key={r.id} className="stagger-item transition-colors duration-150 hover:bg-[var(--hover-surface)]">
                              <td className="px-4 py-2" style={{ color: 'var(--ink-muted)' }}>
                                {new Date(r.accessed_at).toLocaleTimeString()}
                              </td>
                              <td className="px-4 py-2" style={{ color: 'var(--ink-primary)' }}>
                                {r.demat_accounts?.holder_name ?? '—'}
                              </td>
                              <td className="px-4 py-2">
                                {r.profiles?.full_name ?? '—'}
                                {r.is_self_reveal && (
                                  <span className="ml-1.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                                    (self)
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
