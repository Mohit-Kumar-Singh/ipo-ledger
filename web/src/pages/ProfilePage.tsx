import { useEffect, useState, type FormEvent } from 'react'
import { CreditCard, Mail, Phone, Search, ShieldCheck, User, X } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { AttributionChart } from '../components/AttributionChart'
import { computeIpoAttribution, type IpoAttribution } from '../lib/applicationAttribution'
import { resolveAttributionNames, topRecentIpoAttributionRows } from '../lib/dashboardAttribution'
import type { ApplicationAttributionRow, DematAccount, DematLinkRequest, LinkRequestStatus } from '../types/database'

const PHONE_RE = /^[0-9]{10}$/
const PAN_RE = /^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/

interface SearchResult {
  id: string
  holder_name: string
  phone_masked: string
}

type MyRequestRow = DematLinkRequest & { demat_accounts: Pick<DematAccount, 'holder_name'> | null }

const requestStatusBadge: Record<LinkRequestStatus, string> = {
  PENDING: 'badge-warning',
  APPROVED: 'badge-good',
  REJECTED: 'badge-critical',
}

export function ProfilePage() {
  const { session, profile, refreshProfile } = useAuth()
  const [fullName, setFullName] = useState(profile?.full_name ?? '')
  const [phoneDigits, setPhoneDigits] = useState(profile?.phone_e164?.replace(/^\+91/, '') ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const [pan, setPan] = useState('')
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

  useEffect(() => {
    setFullName(profile?.full_name ?? '')
    setPhoneDigits(profile?.phone_e164?.replace(/^\+91/, '') ?? '')
  }, [profile?.full_name, profile?.phone_e164])

  async function loadMyRequests() {
    setLoadingRequests(true)
    const { data } = await supabase
      .from('demat_link_requests')
      .select('*, demat_accounts(holder_name)')
      .order('requested_at', { ascending: false })
    setMyRequests((data ?? []) as MyRequestRow[])
    setLoadingRequests(false)
  }

  useEffect(() => {
    loadMyRequests()
  }, [])

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
            <User size={15} style={{ color: 'var(--ink-muted)' }} />
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
            <Phone size={15} style={{ color: 'var(--ink-muted)' }} />
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
          <Mail size={15} style={{ color: 'var(--ink-muted)' }} />
          {session?.user.email ?? session?.user.phone ?? '—'}
        </div>

        {error && <p className="badge badge-critical w-fit">{error}</p>}

        <button type="submit" disabled={submitting} className="btn-primary py-2.5">
          {submitting ? 'Saving…' : justSaved ? 'Saved ✓' : 'Save changes'}
        </button>
      </form>

      <form onSubmit={handleSavePan} className="card animate-page-in space-y-3 p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} style={{ color: 'var(--accent)' }} />
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            Your PAN
          </h2>
        </div>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          Save your PAN so it can be matched when you request to link a demat account below. Self-attested — the
          admin still approves each link.
        </p>

        <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
          PAN
          <div className="mt-1 flex items-center gap-2">
            <CreditCard size={15} style={{ color: 'var(--ink-muted)' }} />
            <input
              value={pan}
              onChange={(e) => setPan(e.target.value.toUpperCase())}
              maxLength={10}
              placeholder="ABCPD1234E"
              className="input font-mono uppercase"
            />
          </div>
        </label>

        {profile?.self_pan_hash && (
          <p className="text-xs" style={{ color: 'var(--good)' }}>
            A PAN is on file for you — save again anytime to replace it.
          </p>
        )}

        {panResult && <p className={`badge w-fit badge-${panResult.tone}`}>{panResult.message}</p>}

        <button type="submit" disabled={panSubmitting || !pan} className="btn-secondary disabled:opacity-50">
          {panSubmitting ? 'Saving…' : 'Save PAN'}
        </button>
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
          <Search size={15} style={{ color: 'var(--ink-muted)' }} />
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
                      <X size={14} />
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
