import { IconButton, Button } from '@primer/react'
import { SunIcon, MoonIcon } from '@primer/octicons-react'
import { useTheme } from '../contexts/ThemeContext'

export function ThemeToggle({ iconOnly = false }: { iconOnly?: boolean }) {
  const { theme, toggleTheme } = useTheme()
  const isDark = theme === 'dark'
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme'

  if (iconOnly) {
    return (
      <IconButton
        onClick={toggleTheme}
        aria-label={label}
        title={label}
        icon={isDark ? SunIcon : MoonIcon}
        variant="invisible"
        size="small"
      />
    )
  }

  return (
    <Button
      onClick={toggleTheme}
      aria-label={label}
      leadingVisual={isDark ? SunIcon : MoonIcon}
      variant="invisible"
      size="small"
    >
      {isDark ? 'Light' : 'Dark'}
    </Button>
  )
}
