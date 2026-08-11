import type { CSSProperties, ReactNode } from 'react'

// Replaces the old `.card` class — a plain bordered box, Primer's own shape
// for grouped content (GitHub doesn't really have "cards", just bordered
// boxes with Primer's default border/radius tokens).
export function Panel({
  children,
  className = '',
  style,
  danger = false,
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
  danger?: boolean
}) {
  return (
    <div
      className={className}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderColor: danger ? 'var(--critical)' : undefined,
        borderRadius: 6,
        ...style,
      }}
    >
      {children}
    </div>
  )
}
