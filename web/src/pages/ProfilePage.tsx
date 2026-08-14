import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ChevronDownIcon,
  CreditCardIcon,
  LawIcon,
  DeviceMobileIcon,
  InfoIcon,
  PaintbrushIcon,
  PeopleIcon,
  SearchIcon,
  ShieldCheckIcon,
  PersonIcon,
  XIcon,
} from '@primer/octicons-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { ThemeToggle } from '../components/ThemeToggle'
import { useTheme } from '../contexts/ThemeContext'
import { AccountsPage } from './admin/AccountsPage'
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
  const { session, profile, refreshProfile } = useAuth()
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

  useEffect(() => {
    setFullName(profile?.full_name ?? '')
    setPhoneDigits(profile?.phone_e164?.replace(/^\+91/, '') ?? '')
  }, [profile?.full_name, profile?.phone_e164])

  async function loadMyRequests() {
    setLoadingRequests(true)
    const { data, error } = await supabase
      .from('demat_link_requests')
      .select('*, demat_accounts(holder_name)')
      .order('requested_at', { ascending: false })
    if (error) {
      alert(`Couldn't load your link requests: ${error.message}`)
      setLoadingRequests(false)
      return
    }
    setMyRequests((data ?? []) as MyRequestRow[])
    setLoadingRequests(false)
  }

  async function loadMyBankRequests() {
    setLoadingBankRequests(true)
    const { data, error } = await supabase
      .from('bank_link_requests')
      .select('*, bank_accounts(account_holder_name)')
      .order('requested_at', { ascending: false })
    if (error) {
      alert(`Couldn't load your bank link requests: ${error.message}`)
      setLoadingBankRequests(false)
      return
    }
    setMyBankRequests((data ?? []) as MyBankRequestRow[])
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
      alert(error.message)
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setJustSaved(false)

    const trimmed = fullName.trim()
    if (!trimmed) {
      setError('Name cannot be empty.')
      return
    }
    if (!phoneValid) {
      setError('Phone number must be exactly 10 digits, or left blank.')
      return
    }

    setSubmitting(true)
    const { error } = await supabase.rpc('update_own_profile', {
      p_full_name: trimmed,
      p_phone_e164: phoneDigits ? `+91${phoneDigits}` : null,
    })
    setSubmitting(false)
    if (error) {
      setError(error.message)
      return
    }
    await refreshProfile()
    setJustSaved(true)
    setTimeout(() => setJustSaved(false), 2000)
  }

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
      alert(error.message)
      return
    }
    loadMyRequests()
  }

  async function unlinkDemat(id: string) {
    if (!window.confirm('Unlink this account? You can request to re-link it later.')) return
    setUnlinkingDematId(id)
    const { error } = await supabase.rpc('unlink_demat_account', { p_demat_id: id })
    setUnlinkingDematId(null)
    if (error) {
      alert(error.message)
      return
    }
    loadLinkedAccounts()
  }

  async function unlinkBank(id: string) {
    if (!window.confirm('Unlink this bank/UPI account? You can request to re-link it later.')) return
    setUnlinkingBankId(id)
    const { error } = await supabase.rpc('unlink_bank_account', { p_bank_account_id: id })
    setUnlinkingBankId(null)
    if (error) {
      alert(error.message)
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
      alert(error.message)
      return
    }
    loadMyBankRequests()
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Profile
        </h1>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          Your display name signs off the WhatsApp messages you send.
        </p>
      </div>

      {isAdmin && (
        <div className="card animate-page-in space-y-3 p-5">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            Pending link requests
          </h2>
          {loadingReview ? (
            <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
              Loading…
            </p>
          ) : pendingReview.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
              None pending.
            </p>
          ) : (
            // Its own list of items can run long once several members have
            // pending requests at once — a 2-up grid on wider screens keeps
            // this from turning into one long single-column scroll the way
            // the whole page used to (see below), same reasoning as the
            // rest of this redesign.
            <div className="grid grid-cols-1 gap-x-6 divide-y sm:grid-cols-2 sm:gap-y-0 sm:divide-y-0" style={{ borderColor: 'var(--border)' }}>
              {pendingReview.map((r) => (
                <div
                  key={`${r.kind}-${r.id}`}
                  className="flex items-center justify-between gap-3 border-b py-2.5 text-sm last:border-b-0 sm:border-b"
                  style={{ borderColor: 'var(--border)' }}
                >
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

      {/* Identity/PAN card beside the link-request workflows — the pie
          chart that used to fill this blank space (Recent IPOs) is gone
          entirely now, and the request sections moved up from further down
          the page to actually use the room instead of leaving it empty. */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="xl:col-span-1">
      <div className="card animate-page-in space-y-4 p-5">
        <div className="flex items-center gap-3 border-b pb-4" style={{ borderColor: 'var(--border)' }}>
          <div
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-lg font-semibold"
            style={{ background: 'linear-gradient(135deg, var(--violet), var(--accent))', color: 'white' }}
          >
            {(fullName || '?')
              .split(' ')
              .map((p) => p[0])
              .slice(0, 2)
              .join('')
              .toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate font-semibold" style={{ color: 'var(--ink-primary)' }}>
                {fullName || 'Your name'}
              </p>
              <span className="badge badge-info shrink-0" style={{ textTransform: 'capitalize' }}>
                {profile?.role ?? 'member'}
              </span>
            </div>
            <p className="truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
              {session?.user.email ?? session?.user.phone ?? '—'}
            </p>
          </div>
        </div>

        {/* Name + phone + PAN, merged into this one card instead of two
            separate ones — still two independent submits underneath (PAN is
            a distinct, self-attested action with its own consequences), but
            visually one "your details" block. Every explanatory paragraph
            that used to sit as permanent text under a field is now an (i)
            tooltip on hover instead, next to that field's label. */}
        <form id="profile-details-form" onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
            <span className="flex items-center gap-1.5">
              Full name
              <span
                title={`Shown in the sidebar, and used to sign messages — e.g. "— ${fullName.trim() || 'your name'}".`}
                style={{ cursor: 'help', display: 'inline-flex' }}
              >
                <InfoIcon size={12} fill="var(--ink-muted)" />
              </span>
            </span>
            <div className="mt-1 flex items-center gap-2">
              <PersonIcon size={15} fill="var(--ink-muted)" />
              <input required value={fullName} onChange={(e) => setFullName(e.target.value)} className="input" />
            </div>
          </label>

          <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
            <span className="flex items-center gap-1.5">
              Phone number
              <span title="Optional, 10 digits." style={{ cursor: 'help', display: 'inline-flex' }}>
                <InfoIcon size={12} fill="var(--ink-muted)" />
              </span>
            </span>
            <div className="mt-1 flex items-center gap-2">
              <DeviceMobileIcon size={15} fill="var(--ink-muted)" />
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
            {!phoneValid && (
              <p className="mt-1 text-xs" style={{ color: 'var(--critical)' }}>
                Must be exactly 10 digits.
              </p>
            )}
          </label>

          {error && <p className="badge badge-critical w-fit">{error}</p>}
        </form>

        <form onSubmit={handleSavePan} className="space-y-4 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
          {editingPan || !profile?.self_pan_masked ? (
            <>
              <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
                <span className="flex items-center gap-1.5">
                  Your PAN
                  <span
                    title="Save your PAN so it can be matched when you request to link a demat account below. Self-attested — the admin still approves each link."
                    style={{ cursor: 'help', display: 'inline-flex' }}
                  >
                    <InfoIcon size={12} fill="var(--ink-muted)" />
                  </span>
                </span>
                <div className="mt-1 flex items-center gap-2">
                  <CreditCardIcon size={15} fill="var(--ink-muted)" />
                  <input
                    value={pan}
                    onChange={(e) => setPan(e.target.value.toUpperCase())}
                    maxLength={10}
                    placeholder="ABCPD1234E"
                    className="input font-mono uppercase"
                  />
                </div>
              </label>

              {profile?.self_pan_hash && !profile?.self_pan_masked && (
                <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                  A PAN is already on file from before this showed a preview — save it again to see it below.
                </p>
              )}

              {panResult && <p className={`badge w-fit badge-${panResult.tone}`}>{panResult.message}</p>}

              <div className="flex gap-2">
                <button type="submit" disabled={panSubmitting || !pan} className="btn-secondary disabled:opacity-50">
                  {panSubmitting ? 'Saving…' : 'Save PAN'}
                </button>
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
              </div>
            </>
          ) : (
            <>
              <div className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
                <span className="flex items-center gap-1.5">
                  Your PAN
                  <span
                    title="Save your PAN so it can be matched when you request to link a demat account below. Self-attested — the admin still approves each link."
                    style={{ cursor: 'help', display: 'inline-flex' }}
                  >
                    <InfoIcon size={12} fill="var(--ink-muted)" />
                  </span>
                </span>
                <div
                  className="mt-1 flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                  style={{ borderColor: 'var(--border-strong)' }}
                >
                  <span className="flex items-center gap-2 text-sm font-mono" style={{ color: 'var(--ink-primary)' }}>
                    <CreditCardIcon size={15} fill="var(--ink-muted)" />
                    {profile.self_pan_masked}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditingPan(true)}
                    className="link-accent shrink-0 text-xs font-medium"
                  >
                    Change
                  </button>
                </div>
              </div>
              {panResult && <p className={`badge w-fit badge-${panResult.tone}`}>{panResult.message}</p>}
            </>
          )}
        </form>

        {/* Submits the name/phone form above (id="profile-details-form"),
            not this one — placed here instead so it reads as "save
            everything on this card" from the bottom, below PAN, rather than
            splitting the card's one save action in the middle of it. */}
        <button
          type="submit"
          form="profile-details-form"
          disabled={submitting}
          className="btn-primary w-full py-2.5"
        >
          {submitting ? 'Saving…' : justSaved ? 'Saved ✓' : 'Save changes'}
        </button>
      </div>
        </div>

        <div className="xl:col-span-2 space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-6">
      <form onSubmit={handleSearch} className="card animate-page-in space-y-3 p-5">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          Request to link a demat account
          <span
            title="Search by holder name or the last 4 digits of the phone on the account. Only unlinked accounts show up here, and only the name and a masked phone number."
            style={{ cursor: 'help', display: 'inline-flex' }}
          >
            <InfoIcon size={12} fill="var(--ink-muted)" />
          </span>
        </h2>
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
                  onClick={() => handleRequestLink(r.id)}
                  disabled={requestingId === r.id}
                  className="link-accent shrink-0 text-xs font-medium disabled:opacity-50"
                >
                  {requestingId === r.id ? 'Requesting…' : 'Request link'}
                </button>
              </div>
            ))}
          </div>
        )}
      </form>

      <div className="card animate-page-in space-y-3 p-5">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          Your requests
        </h2>
        {loadingRequests ? (
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            Loading…
          </p>
        ) : myRequests.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            No link requests yet.
          </p>
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {myRequests.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div>
                  <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                    {r.demat_accounts?.holder_name ?? '—'}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                    Requested {new Date(r.requested_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`badge ${requestStatusBadge[r.status]}`}>{r.status}</span>
                  {r.status === 'PENDING' && (
                    <button
                      onClick={() => cancelRequest(r.id)}
                      disabled={cancellingId === r.id}
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
        </div>

        <div className="space-y-6">

      <form onSubmit={handleSearchBank} className="card animate-page-in space-y-3 p-5">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          Request to link a bank/UPI account
          <span
            title="For a bank/UPI account someone else (e.g. the admin) already added — search by holder name or last 4 digits, then prove it's yours with the exact UPI ID or last 4 digits to send a request. Adding your own new bank/UPI account from scratch doesn't need this — use the Bank/UPI accounts page for that instead."
            style={{ cursor: 'help', display: 'inline-flex' }}
          >
            <InfoIcon size={12} fill="var(--ink-muted)" />
          </span>
        </h2>
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
                    onClick={() => handleRequestBankLink(r.id)}
                    disabled={requestingBankId === r.id}
                    className="link-accent shrink-0 text-xs font-medium disabled:opacity-50"
                  >
                    {requestingBankId === r.id ? 'Requesting…' : 'Request link'}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </form>

      <div className="card animate-page-in space-y-3 p-5">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          Your bank/UPI link requests
        </h2>
        {loadingBankRequests ? (
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            Loading…
          </p>
        ) : myBankRequests.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            No link requests yet.
          </p>
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {myBankRequests.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div>
                  <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                    {r.bank_accounts?.account_holder_name ?? '—'}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                    Requested {new Date(r.requested_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`badge ${requestStatusBadge[r.status]}`}>{r.status}</span>
                  {r.status === 'PENDING' && (
                    <button
                      onClick={() => cancelBankRequest(r.id)}
                      disabled={cancellingBankId === r.id}
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
        </div>
      </div>

      {(linkedDemat.length > 0 || linkedBank.length > 0) && (
        <div className="card animate-page-in space-y-3 p-5">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            Your linked accounts
          </h2>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            Unlinking is immediate and keeps all history — you can request to re-link later.
          </p>
          <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            {linkedDemat.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 border-b py-2.5 text-sm" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center gap-2">
                  <CreditCardIcon size={15} fill="var(--ink-muted)" />
                  <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                    {d.holder_name}
                  </span>
                  <span className="badge badge-info">demat</span>
                </div>
                <button
                  onClick={() => unlinkDemat(d.id)}
                  disabled={unlinkingDematId === d.id}
                  className="text-xs font-medium hover:underline disabled:opacity-50"
                  style={{ color: 'var(--critical)' }}
                >
                  {unlinkingDematId === d.id ? 'Unlinking…' : 'Unlink'}
                </button>
              </div>
            ))}
            {linkedBank.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-3 border-b py-2.5 text-sm" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center gap-2">
                  <LawIcon size={15} fill="var(--ink-muted)" />
                  <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                    {b.account_holder_name ?? b.upi_id ?? 'Bank/UPI account'}
                  </span>
                  <span className="badge badge-good">bank/UPI</span>
                </div>
                <button
                  onClick={() => unlinkBank(b.id)}
                  disabled={unlinkingBankId === b.id}
                  className="text-xs font-medium hover:underline disabled:opacity-50"
                  style={{ color: 'var(--critical)' }}
                >
                  {unlinkingBankId === b.id ? 'Unlinking…' : 'Unlink'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
        </div>
      </div>

      <AppearanceSection />
      {isAdmin && <PanAccessLogSection />}
      <AccountsSection />
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
        className="flex w-full items-center justify-between gap-2 p-5 text-left transition-colors hover:bg-[var(--hover-surface)]"
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
        <div className="border-t p-5" style={{ borderColor: 'var(--border)' }}>
          <AccountsPage />
        </div>
      )}
    </section>
  )
}

// Moved here from the now-deleted Settings page — Settings only ever held
// this and the PAN access log below, both of which read more like personal
// preferences/your-own-activity than admin-only "settings" (this one isn't
// even admin-gated), so there was no real page left once both moved.
function AppearanceSection() {
  const { theme } = useTheme()
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
        <PaintbrushIcon size={15} fill="var(--accent)" />
        Appearance
      </h2>
      <div className="card flex items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
            Theme
          </p>
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            Currently {theme === 'dark' ? 'dark' : 'light'}.
          </p>
        </div>
        <ThemeToggle />
      </div>
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
    <section className="card animate-page-in overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 p-5 text-left transition-colors hover:bg-[var(--hover-surface)]"
      >
        <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          <ShieldCheckIcon size={16} fill="var(--violet)" />
          PAN access log
        </span>
        <span
          className="inline-flex transition-transform duration-200"
          style={{ color: 'var(--ink-muted)', transform: open ? 'rotate(180deg)' : undefined }}
        >
          <ChevronDownIcon size={16} />
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t p-5" style={{ borderColor: 'var(--border)' }}>
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            Every time a PAN is decrypted (Accounts/Allotment board "Reveal PAN"), it's logged here — who, whose
            PAN, and when. Grouped by day, most recent first.
          </p>
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
                              <td className="px-4 py-2.5" style={{ color: 'var(--ink-muted)' }}>
                                {new Date(r.accessed_at).toLocaleTimeString()}
                              </td>
                              <td className="px-4 py-2.5" style={{ color: 'var(--ink-primary)' }}>
                                {r.demat_accounts?.holder_name ?? '—'}
                              </td>
                              <td className="px-4 py-2.5">
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
