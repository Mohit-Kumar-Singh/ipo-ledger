import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { PersonIcon, MailIcon, ShieldIcon, PhoneIcon } from '../components/icons'

const PHONE_RE = /^[0-9]{10}$/

export function ProfilePage() {
  const { session, profile, refreshProfile } = useAuth()
  const [fullName, setFullName] = useState(profile?.full_name ?? '')
  const [phoneDigits, setPhoneDigits] = useState(profile?.phone_e164?.replace(/^\+91/, '') ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)

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
        <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
          Full name
          <div className="mt-1 flex items-center gap-2">
            <PersonIcon />
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
            <PhoneIcon />
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
          <MailIcon />
          {session?.user.email ?? session?.user.phone ?? '—'}
        </div>

        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--ink-secondary)' }}>
          <ShieldIcon />
          <span className="badge badge-info" style={{ textTransform: 'capitalize' }}>
            {profile?.role ?? 'member'}
          </span>
        </div>

        {error && <p className="badge badge-critical w-fit">{error}</p>}

        <button type="submit" disabled={submitting} className="btn-primary py-2.5">
          {submitting ? 'Saving…' : justSaved ? 'Saved ✓' : 'Save changes'}
        </button>
      </form>
    </div>
  )
}
