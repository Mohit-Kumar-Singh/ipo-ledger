import { SunIcon, MoonIcon } from '@primer/octicons-react'
import { useTheme } from '../contexts/ThemeContext'

export function ThemeToggle({ iconOnly = false }: { iconOnly?: boolean }) {
  const { theme, toggleTheme } = useTheme()
  const isDark = theme === 'dark'
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme'
  const Icon = isDark ? SunIcon : MoonIcon

  if (iconOnly) {
    return (
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={label}
        title={label}
        className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--hover-surface)]"
        style={{ color: 'var(--ink-muted)' }}
      >
        <Icon size={16} />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      className="btn-secondary flex items-center gap-1.5 text-sm"
    >
      <Icon size={16} />
      {isDark ? 'Light' : 'Dark'}
    </button>
  )
}
