import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { ThemeToggle } from '../components/ThemeToggle'

export function LoginPage() {
  const { session } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (session) return <Navigate to="/" replace />

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setSubmitting(false)
    if (error) setError(error.message)
  }

  async function handleGoogle() {
    setError(null)
    await supabase.auth.signInWithOAuth({ provider: 'google' })
  }

  return (
    <div
      className="relative flex min-h-screen items-center justify-center px-4"
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
        <h1 className="mb-1 text-lg font-semibold" style={{ color: 'var(--ink-primary)' }}>
          Sign in to continue
        </h1>
        <p className="mb-6 text-sm" style={{ color: 'var(--ink-muted)' }}>
          Track applications, allotments and mandates in one place.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input mt-1"
            />
          </label>
          <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
            Password
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input mt-1"
            />
          </label>
          {error && <p className="badge badge-critical w-fit">{error}</p>}
          <button type="submit" disabled={submitting} className="btn-primary w-full py-2.5">
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="my-5 flex items-center gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
          <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
          or
          <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
        </div>

        <button onClick={handleGoogle} className="btn-secondary w-full py-2.5">
          Continue with Google
        </button>

        <p className="mt-6 text-xs" style={{ color: 'var(--ink-muted)' }}>
          New members are invited by the admin — there's no self-signup.
        </p>
      </div>
    </div>
  )
}
