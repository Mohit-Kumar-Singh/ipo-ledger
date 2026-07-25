import { useEffect, useState } from 'react'

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
      style={{ color: 'var(--accent)' }}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

// True once a spinner has been mounted for a few seconds — long enough that
// it's very unlikely to be "normal" load time, and much more likely the
// Supabase free-tier project was idle and is waking up (documented ~7-day
// auto-pause; first request after that can take 10-30s). Without this, that
// wait just looks like the app is frozen.
function useIsTakingAWhile(delayMs = 4000) {
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
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-3 px-4"
      style={{ background: 'var(--page)' }}
    >
      <Spinner size={24} />
      {slow && (
        <p className="max-w-xs text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
          Still loading — if this app has been idle a few days, the free-tier database takes up to 30s to
          wake up. It'll be fast again after this.
        </p>
      )}
    </div>
  )
}

export function InlineSpinner({ label = 'Loading…' }: { label?: string }) {
  const slow = useIsTakingAWhile()
  return (
    <div className="flex flex-col gap-1 py-2 text-sm" style={{ color: 'var(--ink-muted)' }}>
      <div className="flex items-center gap-2">
        <Spinner />
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
