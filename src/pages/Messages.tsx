import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useConversations } from '@/hooks/useConversations'
import { DirectThread } from '@/components/chat/DirectThread'
import { Text } from '@/components/primitives'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

const Messages = () => {
  const { conversationId } = useParams<{ conversationId?: string }>()
  const { user } = useAuth()
  const { conversations, loading, refresh } = useConversations()
  const navigate = useNavigate()
  const active = conversations.find((c) => c.conversation_id === conversationId)

  // The Friends page creates a conversation and navigates straight here,
  // before this list has heard about it. If the id in the URL is not in the
  // list, reload the list once for that id before deciding it is missing.
  const [checkedId, setCheckedId] = useState<string | null>(null)
  useEffect(() => {
    if (!conversationId || active || loading || checkedId === conversationId) return
    let cancelled = false
    void refresh().finally(() => {
      if (!cancelled) setCheckedId(conversationId)
    })
    return () => {
      cancelled = true
    }
  }, [conversationId, active, loading, checkedId, refresh])

  if (!user) return null
  const resolving = Boolean(conversationId) && !active && checkedId !== conversationId

  return (
    <div className="max-w-measure">
      <div className="border-b-2 border-foreground pb-6">
        <Text variant="label" tone="faint" as="div">Messages</Text>
        <Text variant="h2" as="h1" className="mt-2">Friends</Text>
      </div>

      <div className="mt-6 grid gap-8 md:grid-cols-[16rem_1fr]">
        <nav aria-label="Conversations" className={cn(conversationId ? 'hidden md:block' : 'block')}>
          {loading && conversations.length === 0 && <Skeleton className="h-12 w-full" />}
          {!loading && conversations.length === 0 && (
            <Text variant="bodySm" tone="muted" as="p">
              No conversations yet. Open one from your <Link to="/friends" className="underline underline-offset-4">friends list</Link>.
            </Text>
          )}
          <ul className="flex flex-col">
            {conversations.map((c) => (
              <li key={c.conversation_id} className="border-b border-border">
                <Link
                  to={`/messages/${c.conversation_id}`}
                  aria-current={c.conversation_id === conversationId ? 'page' : undefined}
                  className={cn(
                    'flex items-center justify-between gap-3 py-3',
                    c.conversation_id === conversationId && 'text-primary',
                  )}
                >
                  <span className="min-w-0">
                    <Text variant="bodySm" className="block truncate font-semibold">{c.friend_name}</Text>
                    {c.last_message && (
                      <Text variant="caption" tone="faint" className="block truncate">{c.last_message}</Text>
                    )}
                  </span>
                  {c.unread_count > 0 && (
                    <span
                      className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 font-data text-[11px] font-semibold text-primary-foreground"
                      aria-label={`${c.unread_count} unread`}
                    >
                      {c.unread_count > 9 ? '9+' : c.unread_count}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <section aria-label="Conversation" className={cn(conversationId ? 'block' : 'hidden md:block')}>
          {conversationId && active && (
            <>
              <button
                type="button"
                onClick={() => navigate('/messages')}
                className="mb-3 inline-flex items-center gap-1.5 text-body-sm text-muted-foreground md:hidden"
              >
                <ArrowLeft className="size-4" aria-hidden="true" /> All conversations
              </button>
              <DirectThread
                key={active.conversation_id}
                conversationId={active.conversation_id}
                currentUserId={user.user.id}
                friendName={active.friend_name}
                canMessage={active.can_message}
                emailVerified={user.emailVerified}
                onRead={refresh}
              />
            </>
          )}
          {resolving && <Skeleton className="h-40 w-full" />}
          {conversationId && !active && !resolving && !loading && (
            <Text variant="body" tone="muted" as="p">This conversation isn't available.</Text>
          )}
          {!conversationId && (
            <Text variant="body" tone="muted" as="p" className="hidden md:block">Select a conversation.</Text>
          )}
        </section>
      </div>
    </div>
  )
}

export default Messages
