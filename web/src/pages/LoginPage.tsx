import { useState, type FormEvent, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { ThemeToggle } from '../components/ThemeToggle'

type Method = 'email' | 'phone'
type EmailMode = 'signin' | 'register'

const PHONE_RE = /^[0-9]{10}$/

export function LoginPage() {
  const { session } = useAuth()
  const [method, setMethod] = useState<Method>('email')
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
      <ThemeToggle className="absolute top-4 right-4" />
      <div
        className="w-full max-w-sm rounded-xl border p-7 shadow-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <div className="mb-6 flex items-center gap-2">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-md text-sm font-semibold text-white"
            style={{ background: 'var(--accent)' }}
          >
            I
          </div>
          <span className="text-base font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            IPO Ledger
          </span>
        </div>

        <div
          className="mb-5 flex gap-1 rounded-lg p-1"
          style={{ background: 'var(--page)' }}
          role="tablist"
          aria-label="Sign-in method"
        >
          <MethodTab active={method === 'email'} onClick={() => setMethod('email')}>
            Email
          </MethodTab>
          <MethodTab active={method === 'phone'} onClick={() => setMethod('phone')}>
            Phone
          </MethodTab>
        </div>

        {method === 'email' ? (
          <>
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
          </>
        ) : (
          <PhoneAuthForm />
        )}

        <div className="my-5 flex items-center gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
          <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
          or
          <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
        </div>

        <button onClick={handleGoogle} className="btn-secondary w-full py-2.5">
          Continue with Google
        </button>

        <p className="mt-6 text-xs" style={{ color: 'var(--ink-muted)' }}>
          Creating an account gives you read-only access. An admin still needs to link it to a demat account
          before you'll see any data.
        </p>
      </div>
    </div>
  )
}

function MethodTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors"
      style={
        active
          ? { background: 'var(--surface)', color: 'var(--ink-primary)', boxShadow: '0 1px 2px rgba(11,11,11,0.06)' }
          : { color: 'var(--ink-muted)' }
      }
    >
      {children}
    </button>
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

function PhoneAuthForm() {
  const [phoneDigits, setPhoneDigits] = useState('')
  const [otp, setOtp] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const phoneValid = PHONE_RE.test(phoneDigits)
  const fullPhone = `+91${phoneDigits}`

  async function sendCode(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!phoneValid) {
      setError('Phone number must be exactly 10 digits.')
      return
    }
    setSubmitting(true)
    const { error } = await supabase.auth.signInWithOtp({ phone: fullPhone })
    setSubmitting(false)
    if (error) {
      setError(error.message)
      return
    }
    setCodeSent(true)
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const { error } = await supabase.auth.verifyOtp({ phone: fullPhone, token: otp, type: 'sms' })
    setSubmitting(false)
    if (error) setError(error.message)
  }

  if (!codeSent) {
    return (
      <form onSubmit={sendCode} className="space-y-3">
        <Field label="Phone number" hint="10 digits, no country code">
          <div className="flex items-center gap-2">
            <span
              className="rounded-md border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--ink-muted)' }}
            >
              +91
            </span>
            <input
              required
              inputMode="numeric"
              maxLength={10}
              value={phoneDigits}
              onChange={(e) => setPhoneDigits(e.target.value.replace(/[^0-9]/g, ''))}
              className="input"
              placeholder="9876543210"
              autoComplete="tel-national"
            />
          </div>
        </Field>
        {error && <p className="badge badge-critical w-fit">{error}</p>}
        <button type="submit" disabled={submitting} className="btn-primary w-full py-2.5">
          {submitting ? 'Sending code…' : 'Send code'}
        </button>
      </form>
    )
  }

  return (
    <form onSubmit={verifyCode} className="space-y-3">
      <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
        Code sent to +91 {phoneDigits}.{' '}
        <button
          type="button"
          onClick={() => {
            setCodeSent(false)
            setOtp('')
            setError(null)
          }}
          className="link-accent"
        >
          Change number
        </button>
      </p>
      <Field label="6-digit code">
        <input
          required
          inputMode="numeric"
          maxLength={6}
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/[^0-9]/g, ''))}
          className="input font-mono tracking-widest"
          placeholder="123456"
          autoComplete="one-time-code"
        />
      </Field>
      {error && <p className="badge badge-critical w-fit">{error}</p>}
      <button type="submit" disabled={submitting || otp.length < 6} className="btn-primary w-full py-2.5">
        {submitting ? 'Verifying…' : 'Verify & continue'}
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
