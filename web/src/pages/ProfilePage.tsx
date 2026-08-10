import { useEffect, useState, type FormEvent } from 'react'
import { CreditCardIcon, LawIcon, MailIcon, DeviceMobileIcon, SearchIcon, ShieldCheckIcon, PersonIcon, XIcon } from '@primer/octicons-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { AttributionChart } from '../components/AttributionChart'
import { computeIpoAttribution, type IpoAttribution } from '../lib/applicationAttribution'
import { resolveAttributionNames, topRecentIpoAttributionRows } from '../lib/dashboardAttribution'
import type {
  ApplicationAttributionRow,
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
  const [attribution, setAttribution] = useState<IpoAttribution[] | null>(null)

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

  useEffect(() => {
    let cancelled = false
    async function loadAttribution() {
      const { data } = await supabase.from('v_application_attribution').select('*')
      if (cancelled) return
      const scopedRows = topRecentIpoAttributionRows((data ?? []) as ApplicationAttributionRow[], 4)
      const nameById = await resolveAttributionNames(scopedRows)
      if (cancelled) return
      setAttribution(computeIpoAttribution(scopedRows, nameById).sort((a, b) => b.openDate.localeCompare(a.openDate)))
    }
    loadAttribution()
    return () => {
      cancelled = true
    }
  }, [])

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
    <div className="max-w-lg space-y-6">
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
            <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {pendingReview.map((r) => (
                <div key={`${r.kind}-${r.id}`} className="flex items-center justify-between gap-3 py-2.5 text-sm">
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

      <form onSubmit={handleSubmit} className="card animate-page-in space-y-4 p-5">
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
          <div>
            <p className="font-semibold" style={{ color: 'var(--ink-primary)' }}>
              {fullName || 'Your name'}
            </p>
            <span className="badge badge-info mt-0.5" style={{ textTransform: 'capitalize' }}>
              {profile?.role ?? 'member'}
            </span>
          </div>
        </div>

        <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
          Full name
          <div className="mt-1 flex items-center gap-2">
            <PersonIcon size={15} fill="var(--ink-muted)" />
            <input required value={fullName} onChange={(e) => setFullName(e.target.value)} className="input" />
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
            Shown in the sidebar, and used to sign messages — e.g. "— {fullName.trim() || 'your name'}".
          </p>
        </label>

        <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
          <span className="flex items-baseline justify-between gap-2">
            Phone number
            <span className="text-xs font-normal" style={{ color: 'var(--ink-muted)' }}>
              optional, 10 digits
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

        <div className="flex items-center gap-2 border-t pt-4 text-sm" style={{ borderColor: 'var(--border)', color: 'var(--ink-secondary)' }}>
          <MailIcon size={15} fill="var(--ink-muted)" />
          {session?.user.email ?? session?.user.phone ?? '—'}
        </div>

        {error && <p className="badge badge-critical w-fit">{error}</p>}

        <button type="submit" disabled={submitting} className="btn-primary py-2.5">
          {submitting ? 'Saving…' : justSaved ? 'Saved ✓' : 'Save changes'}
        </button>
      </form>

      <form onSubmit={handleSavePan} className="card animate-page-in space-y-3 p-5">
        <div className="flex items-center gap-2">
          <ShieldCheckIcon size={16} fill="var(--accent)" />
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            Your PAN
          </h2>
        </div>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          Save your PAN so it can be matched when you request to link a demat account below. Self-attested — the
          admin still approves each link.
        </p>

        {editingPan || !profile?.self_pan_masked ? (
          <>
            <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
              PAN
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
            <div
              className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
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
            {panResult && <p className={`badge w-fit badge-${panResult.tone}`}>{panResult.message}</p>}
          </>
        )}
      </form>

      <form onSubmit={handleSearch} className="card animate-page-in space-y-3 p-5">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          Request to link a demat account
        </h2>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          Search by holder name or the last 4 digits of the phone on the account. Only unlinked accounts show up
          here, and only the name and a masked phone number.
        </p>
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

      {(linkedDemat.length > 0 || linkedBank.length > 0) && (
        <div className="card animate-page-in space-y-3 p-5">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            Your linked accounts
          </h2>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            Unlinking is immediate and keeps all history — you can request to re-link later.
          </p>
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {linkedDemat.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
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
              <div key={b.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
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

      <form onSubmit={handleSearchBank} className="card animate-page-in space-y-3 p-5">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          Request to link a bank/UPI account
        </h2>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          For a bank/UPI account someone else (e.g. the admin) already added — search by holder name or last 4
          digits, then prove it's yours with the exact UPI ID or last 4 digits to send a request. Adding your own new
          bank/UPI account from scratch doesn't need this — use the Bank/UPI accounts page for that instead.
        </p>
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

      <div className="card animate-page-in space-y-4 p-5">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          Recent IPOs
        </h2>
        {attribution == null ? (
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            Loading…
          </p>
        ) : attribution.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            No applications yet.
          </p>
        ) : (
          <div className="space-y-4">
            {attribution.map((a) => (
              <AttributionChart key={a.ipoId} attribution={a} compact />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
