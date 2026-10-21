import { Landmark } from 'lucide-react'

// Marks a shareholder-quota application / eligibility (an account holder who
// owns the IPO's parent company shares) — same icon on the Dashboard's
// "accounts yet to apply" list and on the Applications rows, so the two read
// as the same thing.
export function ShareholderQuotaIcon({ size = 13, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 align-middle ${className}`}
      title="Shareholder quota"
      aria-label="Shareholder quota"
      role="img"
      style={{ color: 'var(--accent)' }}
    >
      <Landmark size={size} />
    </span>
  )
}
