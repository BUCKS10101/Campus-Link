import { Link } from 'react-router-dom'
import { MessageCircle } from 'lucide-react'
import { useConversations } from '@/hooks/useConversations'
import { formatUnreadCount } from '@/lib/notificationContent'
import { cn } from '@/lib/utils'

/** Header entry point to friend conversations, with an unread badge. */
export function MessagesLink() {
  const { totalUnread } = useConversations()
  const label = totalUnread > 0 ? `Messages, ${totalUnread} unread` : 'Messages'

  return (
    <Link
      to="/messages"
      aria-label={label}
      className={cn(
        'relative inline-flex size-10 items-center justify-center rounded-md text-foreground',
        'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      <MessageCircle className="size-5" aria-hidden="true" />
      {totalUnread > 0 && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-data text-[10px] font-semibold leading-none tabular-nums text-primary-foreground"
        >
          {formatUnreadCount(totalUnread)}
        </span>
      )}
    </Link>
  )
}
