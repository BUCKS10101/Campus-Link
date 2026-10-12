import * as React from 'react'
import { X } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { IconButton, Text } from '@/components/primitives'

export const THEME_NOTICE_MESSAGE =
  'CampusLink uses light mode by default. You can switch to dark mode anytime using the theme toggle.'

const storageKey = (userId: string) => `campuslink:theme-notice-seen:${userId}`

const hasSeen = (userId: string) => {
  try {
    return localStorage.getItem(storageKey(userId)) === '1'
  } catch {
    return false
  }
}

/**
 * One-time notice per account (remembered in this browser). Mounted once in
 * the app shell, so it never repeats per page or per render.
 */
export function ThemeNotice() {
  const { user } = useAuth()
  const userId = user?.user.id
  const [dismissedFor, setDismissedFor] = React.useState<string | null>(null)

  if (!userId || dismissedFor === userId || hasSeen(userId)) return null

  const dismiss = () => {
    try {
      localStorage.setItem(storageKey(userId), '1')
    } catch {
      // Storage unavailable: the notice is still dismissed for this page load.
    }
    setDismissedFor(userId)
  }

  return (
    <div role="status" className="border-b border-border bg-primary-soft">
      <div className="mx-auto flex max-w-screen-xl items-center justify-between gap-4 px-4 py-2.5">
        <Text variant="bodySm">{THEME_NOTICE_MESSAGE}</Text>
        <IconButton label="Dismiss theme notice" variant="ghost" onClick={dismiss}>
          <X />
        </IconButton>
      </div>
    </div>
  )
}
