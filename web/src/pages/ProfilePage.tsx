import { useEffect, useState, type FormEvent } from 'react'
import { CreditCard, Mail, Phone, ShieldCheck, User } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

const PHONE_RE = /^[0-9]{10}$/
const PAN_RE = /^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/

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

  useEffect(() => {
    setFullName(profile?.full_name ?? '')
    setPhoneDigits(profile?.phone_e164?.replace(/^\+91/, '') ?? '')
  }, [profile?.full_name, profile?.phone_e164])

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

  async function handleVerifyPan(e: FormEvent) {
    e.preventDefault()
    setPanResult(null)

    const normalized = pan.trim().toUpperCase()
    if (!PAN_RE.test(normalized)) {
      setPanResult({ tone: 'critical', message: 'PAN must be in the format ABCPD1234E (5 letters, 4 digits, 1 letter).' })
      return
    }

    setPanSubmitting(true)
    const { data, error } = await supabase.rpc('link_self_by_pan', { p_pan: normalized })
    setPanSubmitting(false)
    if (error) {
      setPanResult({ tone: 'critical', message: error.message })
      return
    }

    const status = (data as { status: string; holder_name?: string } | null)?.status
    if (status === 'linked') {
      setPanResult({
        tone: 'good',
        message: `Verified — linked to ${(data as { holder_name: string }).holder_name}'s account. It'll show up under Accounts now.`,
      })
      setPan('')
    } else if (status === 'linked_elsewhere') {
      setPanResult({ tone: 'warning', message: 'This PAN is already linked to another account. Contact the admin if that looks wrong.' })
    } else {
      setPanResult({
        tone: 'warning',
        message: "No matching account found yet. Once the admin adds it, come back and try again.",
      })
    }
    await refreshProfile()
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

      <form onSubmit={handleVerifyPan} className="card animate-page-in space-y-3 p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} style={{ color: 'var(--accent)' }} />
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            Link your account
          </h2>
        </div>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          Want to link your account? Enter your PAN below and get verified — if it matches a demat account already
          on file, it's linked to you immediately.
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
            A PAN is on file for you — verify again anytime, e.g. after the admin adds your account.
          </p>
        )}

        {panResult && <p className={`badge w-fit badge-${panResult.tone}`}>{panResult.message}</p>}

        <button type="submit" disabled={panSubmitting || !pan} className="btn-secondary disabled:opacity-50">
          {panSubmitting ? 'Verifying…' : 'Verify'}
        </button>
      </form>
    </div>
  )
}
