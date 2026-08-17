import { useState, type FormEvent, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { ThemeToggle } from '../components/ThemeToggle'
import { Logo } from '../components/Logo'

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
      className="relative flex min-h-screen items-center justify-center px-4 py-8"
      style={{ background: 'var(--page)' }}
    >
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div
        className="animate-page-in relative w-full max-w-sm rounded-md p-7"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        <div className="mb-6">
          <Logo size={30} />
        </div>

        <div className="mb-5 flex gap-4 text-sm font-medium">
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

        <button type="button" onClick={handleGoogle} className="btn-secondary w-full">
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

// Plain label + .input, not @primer/react's FormControl/TextInput —
// removed app-wide (see AppShell.tsx's own note): this app already has
// .input everywhere else (IposPage, ApplicationsPage forms, ...), so this
// was the one holdout still pulling in Primer for a text field.
function Field({
  label,
  caption,
  children,
}: {
  label: string
  caption?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-secondary)' }}>
        {label}
      </span>
      {children}
      {caption && (
        <span className="mt-1 block text-xs" style={{ color: 'var(--ink-muted)' }}>
          {caption}
        </span>
      )}
    </label>
  )
}

// Same shape as the error card ApplicationsPage/NotificationsPage already
// use for load errors — a flat tinted line, not Primer's <Flash>.
function InlineMessage({ tone, children }: { tone: 'danger' | 'success'; children: ReactNode }) {
  const color = tone === 'danger' ? 'var(--critical)' : 'var(--good)'
  return (
    <p className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: color, color }}>
      {children}
    </p>
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
          autoComplete="email"
          className="input"
        />
      </Field>
      <Field label="Password">
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="input"
        />
      </Field>
      {error && <InlineMessage tone="danger">{error}</InlineMessage>}
      <button type="submit" disabled={submitting} className="btn-primary w-full">
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
          autoComplete="email"
          className="input"
        />
      </Field>
      <Field label="Password" caption="8+ characters">
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          className="input"
        />
      </Field>
      <Field label="Confirm password">
        <input
          type="password"
          required
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          className="input"
        />
      </Field>
      {error && <InlineMessage tone="danger">{error}</InlineMessage>}
      {notice && <InlineMessage tone="success">{notice}</InlineMessage>}
      <button type="submit" disabled={submitting} className="btn-primary w-full">
        {submitting ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  )
}
