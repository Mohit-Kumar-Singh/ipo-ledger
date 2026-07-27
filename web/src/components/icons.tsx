// Small stroke icons shared across row/tile UIs (Accounts, Profile, ...) —
// same 14-15px outline style, subtle by default (var(--ink-muted)) so they
// sit quietly next to text instead of competing with it.
interface IconProps {
  size?: number
  color?: string
  className?: string
}

export function PersonIcon({ size = 15, color = 'var(--ink-muted)', className = 'shrink-0' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color }} className={className}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
    </svg>
  )
}

export function CardIcon({ size = 14, color = 'var(--ink-muted)', className = 'shrink-0' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color }} className={className}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </svg>
  )
}

export function HashIcon({ size = 14, color = 'var(--ink-muted)', className = 'shrink-0' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color }} className={className}>
      <path d="M5 9h14M5 15h14M11 4L8 20M16 4l-3 16" />
    </svg>
  )
}

export function PhoneIcon({ size = 14, color = 'var(--ink-muted)', className = 'shrink-0' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color }} className={className}>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 3a2 2 0 0 1-.4 2.1L8.1 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2-.4c1 .3 2 .5 3 .7a2 2 0 0 1 1.7 2z" />
    </svg>
  )
}

export function MailIcon({ size = 14, color = 'var(--ink-muted)', className = 'shrink-0' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color }} className={className}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m2 7 10 6 10-6" />
    </svg>
  )
}

export function ShieldIcon({ size = 14, color = 'var(--ink-muted)', className = 'shrink-0' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color }} className={className}>
      <path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5l-8-3z" />
    </svg>
  )
}
