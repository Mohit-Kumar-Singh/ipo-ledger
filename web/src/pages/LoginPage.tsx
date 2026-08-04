import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { Button, FormControl, TextInput, Flash } from '@primer/react'
import { MarkGithubIcon } from '@primer/octicons-react'
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
        <div className="mb-6 flex items-center gap-2">
          <MarkGithubIcon size={28} />
          <span className="text-base font-semibold" style={{ color: 'var(--ink-primary)' }}>
            IPO Ledger
          </span>
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

        <Button onClick={handleGoogle} block>
          Continue with Google
        </Button>

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
      <FormControl required>
        <FormControl.Label>Email</FormControl.Label>
        <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" block />
      </FormControl>
      <FormControl required>
        <FormControl.Label>Password</FormControl.Label>
        <TextInput
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          block
        />
      </FormControl>
      {error && <Flash variant="danger">{error}</Flash>}
      <Button type="submit" variant="primary" disabled={submitting} block>
        {submitting ? 'Signing in…' : 'Sign in'}
      </Button>
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
      <FormControl required>
        <FormControl.Label>Full name</FormControl.Label>
        <TextInput value={fullName} onChange={(e) => setFullName(e.target.value)} block />
      </FormControl>
      <FormControl required>
        <FormControl.Label>Email</FormControl.Label>
        <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" block />
      </FormControl>
      <FormControl required>
        <FormControl.Label>Password</FormControl.Label>
        <FormControl.Caption>8+ characters</FormControl.Caption>
        <TextInput
          type="password"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          block
        />
      </FormControl>
      <FormControl required>
        <FormControl.Label>Confirm password</FormControl.Label>
        <TextInput
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          block
        />
      </FormControl>
      {error && <Flash variant="danger">{error}</Flash>}
      {notice && <Flash variant="success">{notice}</Flash>}
      <Button type="submit" variant="primary" disabled={submitting} block>
        {submitting ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  )
}
