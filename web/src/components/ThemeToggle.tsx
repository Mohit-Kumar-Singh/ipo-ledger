import type { CSSProperties } from 'react'
import { useTheme } from '../contexts/ThemeContext'

export function ThemeToggle({
  className = '',
  style,
  iconOnly = false,
}: {
  className?: string
  style?: CSSProperties
  iconOnly?: boolean
}) {
  const { theme, toggleTheme } = useTheme()
  const isDark = theme === 'dark'

  return (
    <button
      onClick={toggleTheme}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-label="Toggle theme"
      className={`flex shrink-0 items-center gap-1.5 rounded-md text-xs font-medium transition-colors hover:bg-[var(--hover-surface)] ${
        iconOnly ? 'p-1.5' : 'px-2 py-1.5'
      } ${className}`}
      style={{ color: 'var(--ink-secondary)', ...style }}
    >
      {isDark ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
      {!iconOnly && (isDark ? 'Light' : 'Dark')}
    </button>
  )
}
