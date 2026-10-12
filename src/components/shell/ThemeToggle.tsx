import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { IconButton } from '@/components/primitives'

/**
 * Light/dark switch for the header. Uses next-themes, the same single
 * source of truth as the Settings page switch, so the two can never
 * disagree. A native button, so Enter/Space work and focus is visible.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  return (
    <IconButton
      label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      variant="ghost"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {isDark ? <Sun /> : <Moon />}
    </IconButton>
  )
}
