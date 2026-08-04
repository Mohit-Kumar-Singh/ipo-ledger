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
        background: 'var(--bgColor-default)',
        border: '1px solid var(--borderColor-default)',
        borderColor: danger ? 'var(--borderColor-danger-emphasis)' : undefined,
        borderRadius: 6,
        ...style,
      }}
    >
      {children}
    </div>
  )
}
