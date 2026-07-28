import { useState, type FormEvent, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { ThemeToggle } from '../components/ThemeToggle'

type EmailMode = 'signin' | 'register'

export function LoginPage() {
  const { session } = useAuth()
  const [emailMode, setEmailMode] = useState<EmailMode>('signin')

  if (session) return <Navigate to="/" replace />

  async function handleGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
  }

  return (
    <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-8"
      style={{ background: 'var(--page)' }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 -left-24 h-80 w-80 rounded-full opacity-30 blur-3xl"
        style={{ background: 'var(--accent)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -bottom-32 h-80 w-80 rounded-full opacity-20 blur-3xl"
        style={{ background: 'var(--violet)' }}
      />

      <ThemeToggle className="absolute top-4 right-4" />
      <div className="card animate-page-in relative w-full max-w-sm p-7" style={{ boxShadow: 'var(--shadow-lg)' }}>
        <div className="mb-6 flex items-center gap-2">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-md text-sm font-semibold text-white"
            style={{ background: 'linear-gradient(135deg, var(--btn-primary-bg), var(--accent))' }}
          >
            I
          </div>
          <span className="text-base font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            IPO Ledger
          </span>
        </div>

        <div className="mb-5 flex gap-4 text-sm font-medium" style={{ borderColor: 'var(--border)' }}>
          <button
            onClick={() => setEmailMode('signin')}
            className="pb-2"
            style={{
              color: emailMode === 'signin' ? 'var(--accent)' : 'var(--ink-muted)',
              borderBottom: emailMode === 'signin' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            Sign in
          </button>
          <button
            onClick={() => setEmailMode('register')}
            className="pb-2"
            style={{
              color: emailMode === 'register' ? 'var(--accent)' : 'var(--ink-muted)',
              borderBottom: emailMode === 'register' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            Create account
          </button>
        </div>
        {emailMode === 'signin' ? <EmailSignInForm /> : <EmailRegisterForm />}

        <div className="my-5 flex items-center gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
          <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
          or
          <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
        </div>

        <button onClick={handleGoogle} className="btn-secondary w-full py-2.5">
          Continue with Google
        </button>

        <p className="mt-6 text-xs" style={{ color: 'var(--ink-muted)' }}>
          Creating an account gives you your own portal — add your demat/PAN and bank/UPI accounts and start
          tracking IPO applications.
        </p>
      </div>
    </div>
  )
}

function EmailSignInForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setSubmitting(false)
    if (error) setError(error.message)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <Field label="Email">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="input"
          autoComplete="email"
        />
      </Field>
      <Field label="Password">
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input"
          autoComplete="current-password"
        />
      </Field>
      {error && <p className="badge badge-critical w-fit">{error}</p>}
      <button type="submit" disabled={submitting} className="btn-primary w-full py-2.5">
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}

function EmailRegisterForm() {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.")
      return
    }

    setSubmitting(true)
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: window.location.origin,
      },
    })
    setSubmitting(false)
    if (error) {
      setError(error.message)
      return
    }
    if (!data.session) {
      setNotice('Account created — check your email to confirm it before signing in.')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <Field label="Full name">
        <input required value={fullName} onChange={(e) => setFullName(e.target.value)} className="input" />
      </Field>
      <Field label="Email">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="input"
          autoComplete="email"
        />
      </Field>
      <Field label="Password" hint="8+ characters">
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input"
          autoComplete="new-password"
        />
      </Field>
      <Field label="Confirm password">
        <input
          type="password"
          required
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="input"
          autoComplete="new-password"
        />
      </Field>
      {error && <p className="badge badge-critical w-fit">{error}</p>}
      {notice && <p className="badge badge-good w-fit">{notice}</p>}
      <button type="submit" disabled={submitting} className="btn-primary w-full py-2.5">
        {submitting ? 'Creating account…' : 'Create account'}
      </button>
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
