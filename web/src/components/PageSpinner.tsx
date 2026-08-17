import { useEffect, useState } from 'react'
import { LogoSpinner } from './Logo'

// Hand-rolled spinner (a spinning ring via Tailwind's animate-spin), not
// @primer/react's <Spinner> — that pulled in the whole primer/react +
// styled-components runtime (~150KB+ of the app's eager main bundle) for
// what's a single rotating circle, when every other visual in this app is
// already plain Tailwind + this app's own CSS custom properties.
function Spinner({ size = 16 }: { size?: number }) {
  return (
    <div
      className="animate-spin rounded-full border-2"
      style={{ width: size, height: size, borderColor: 'var(--border-strong)', borderTopColor: 'var(--accent)' }}
      role="status"
      aria-label="Loading"
    />
  )
}

// True once a spinner has been mounted for a few seconds — long enough that
// it's very unlikely to be "normal" load time, and much more likely the
// Supabase free-tier project was idle and is waking up (documented ~7-day
// auto-pause; first request after that can take 10-30s). Without this, that
// wait just looks like the app is frozen.
function useIsTakingAWhile(delayMs = 5000) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), delayMs)
    return () => clearTimeout(t)
  }, [delayMs])
  return slow
}

export function PageSpinner() {
  const slow = useIsTakingAWhile()
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-4" style={{ background: 'var(--page)' }}>
      <LogoSpinner size={52} />
      {slow && (
        <p className="max-w-xs text-center text-sm italic" style={{ color: 'var(--ink-muted)' }}>
          If this takes more than 5 sec, it's your network's fault, not mine.
        </p>
      )}
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />
}

export function InlineSpinner({ label = 'Loading…' }: { label?: string }) {
  const slow = useIsTakingAWhile()
  return (
    <div className="flex flex-col gap-1 py-2 text-sm" style={{ color: 'var(--ink-muted)' }}>
      <div className="flex items-center gap-2">
        <Spinner size={14} />
        {label}
      </div>
      {slow && (
        <p className="text-xs">
          Taking longer than usual — likely a cold start after inactivity (free-tier database), not stuck.
        </p>
      )}
    </div>
  )
}
