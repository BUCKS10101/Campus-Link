import type { RealtimeChannel } from '@supabase/supabase-js'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { getErrorMessage } from '@/lib/utils'
import { untypedSupabase as db, type DirectConversationSummary } from '@/lib/directMessages'

interface ConversationsContextValue {
  conversations: DirectConversationSummary[]
  totalUnread: number
  loading: boolean
  refresh: () => Promise<void>
  /** Finds or creates the one conversation with an accepted friend; returns its id. */
  startConversation: (friendId: string) => Promise<string>
}

const ConversationsContext = createContext<ConversationsContextValue | null>(null)

/**
 * App-wide list of friend conversations and the unread total for the nav.
 * One realtime channel, filtered server-side to messages addressed to the
 * signed-in user (recipient_id), so this never sees other users' traffic
 * and is not a table-wide subscription. Events trigger a debounced
 * re-fetch of the summary RPC; there is no polling.
 */
export function ConversationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const userId = user?.user.id
  const [conversations, setConversations] = useState<DirectConversationSummary[]>([])
  const [loading, setLoading] = useState(false)
  const activeUser = useRef<string | undefined>(userId)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    const forUser = activeUser.current
    if (!forUser) return
    const { data, error } = await db.rpc('get_my_direct_conversations')
    if (activeUser.current !== forUser) return
    if (error) {
      console.error('Error loading conversations:', error)
      return
    }
    setConversations((data ?? []) as DirectConversationSummary[])
  }, [])

  const scheduleRefresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void refresh(), 300)
  }, [refresh])

  useEffect(() => {
    activeUser.current = userId
    setConversations([])
    if (!userId) return

    setLoading(true)
    void refresh().finally(() => {
      if (activeUser.current === userId) setLoading(false)
    })

    let cancelled = false
    let channel: RealtimeChannel | undefined

    const connect = () => {
      channel = db
      .channel(`direct_inbox:${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'direct_messages', filter: `recipient_id=eq.${userId}` },
        scheduleRefresh,
      )
      .subscribe((status: string) => {
        if (status !== 'SUBSCRIBED') return
        // Re-sync on every join (first included) to close the gap between
        // the initial load and live delivery, and after any reconnect.
        scheduleRefresh()
      })
    }

    // Apply the signed-in user's token to the realtime socket before
    // joining - otherwise the channel can join as anon and RLS hides
    // every event (see useDirectMessages.ts).
    void db.realtime.setAuth().catch(() => undefined).then(() => {
      if (!cancelled) connect()
    })

    return () => {
      cancelled = true
      activeUser.current = undefined
      if (timer.current) clearTimeout(timer.current)
      if (channel) void db.removeChannel(channel)
    }
  }, [userId, refresh, scheduleRefresh])

  const startConversation = useCallback(async (friendId: string) => {
    const { data, error } = await db.rpc('get_or_create_direct_conversation', { p_friend_id: friendId })
    if (error) throw new Error(getErrorMessage(error, 'Could not open conversation'))
    void refresh()
    return data as string
  }, [refresh])

  const totalUnread = useMemo(
    () => conversations.reduce((sum, c) => sum + c.unread_count, 0),
    [conversations],
  )

  const value = useMemo(
    () => ({ conversations, totalUnread, loading, refresh, startConversation }),
    [conversations, totalUnread, loading, refresh, startConversation],
  )

  return <ConversationsContext.Provider value={value}>{children}</ConversationsContext.Provider>
}

export const useConversations = () => {
  const ctx = useContext(ConversationsContext)
  if (!ctx) throw new Error('useConversations must be used within a ConversationsProvider')
  return ctx
}
