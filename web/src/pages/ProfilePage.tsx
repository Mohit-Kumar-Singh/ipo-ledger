import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { PersonIcon, MailIcon, ShieldIcon } from '../components/icons'

export function ProfilePage() {
  const { session, profile, refreshProfile } = useAuth()
  const [fullName, setFullName] = useState(profile?.full_name ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setFullName(profile?.full_name ?? '')
  }, [profile?.full_name])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(false)

    const trimmed = fullName.trim()
    if (!trimmed) {
      setError('Name cannot be empty.')
      return
    }

    setSubmitting(true)
    const { error } = await supabase.rpc('update_own_full_name', { p_full_name: trimmed })
    setSubmitting(false)
    if (error) {
      setError(error.message)
      return
    }
    await refreshProfile()
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
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
        {saved && <p className="badge badge-good w-fit">Saved</p>}

        <button type="submit" disabled={submitting} className="btn-primary py-2.5">
          {submitting ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </div>
  )
}
