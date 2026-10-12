import { useCallback, useEffect, useRef, useState } from 'react'
import { ChatMessageSchema, validateOrThrow } from '@/lib/validation'
import { getErrorMessage } from '@/lib/utils'
import {
  DIRECT_MESSAGE_PAGE_SIZE,
  mergeMessages,
  untypedSupabase as db,
  type DirectMessage,
} from '@/lib/directMessages'

export type RealtimeStatus = 'connecting' | 'live' | 'reconnecting'

/**
 * Messages for one friend-to-friend conversation: the newest page from the
 * database, plus a realtime subscription scoped to this one conversation.
 *
 * - The database is the source of truth. A sent message is only added
 *   after the insert succeeds, and rows are merged by id, so the insert
 *   response and the realtime event for the same row never duplicate.
 * - The channel is created per conversation and removed on change or
 *   unmount; events whose conversation_id is not the active one are
 *   ignored, so a late event cannot land in the wrong thread.
 * - After a reconnect the latest page is re-fetched and merged, which
 *   recovers anything missed while disconnected.
 */
export const useDirectMessages = (
  conversationId: string | undefined,
  currentUserId: string | undefined,
  onRead?: () => void,
) => {
  const [messages, setMessages] = useState<DirectMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [status, setStatus] = useState<RealtimeStatus>('connecting')

  const activeId = useRef<string | undefined>(conversationId)
  const onReadRef = useRef(onRead)
  onReadRef.current = onRead

  const fetchLatest = useCallback(async (id: string, initial: boolean) => {
    if (initial) setLoading(true)
    try {
      const { data, error: fetchError } = await db
        .from('direct_messages')
        .select('*')
        .eq('conversation_id', id)
        .order('created_at', { ascending: false })
        .limit(DIRECT_MESSAGE_PAGE_SIZE)
      if (fetchError) throw fetchError
      if (activeId.current !== id) return
      const rows = ((data ?? []) as DirectMessage[]).slice().reverse()
      setMessages((prev) => (initial ? rows : mergeMessages(prev, rows)))
      if (initial) setHasMore((data ?? []).length === DIRECT_MESSAGE_PAGE_SIZE)
      setError(null)
    } catch (err) {
      if (activeId.current !== id) return
      console.error('Error fetching direct messages:', err)
      // A failed background re-sync must not wipe a thread that loaded fine.
      if (initial) setError(getErrorMessage(err, 'Failed to load messages'))
    } finally {
      if (initial && activeId.current === id) setLoading(false)
    }
  }, [])

  useEffect(() => {
    activeId.current = conversationId
    setMessages([])
    setHasMore(false)
    setError(null)
    setStatus('connecting')
    if (!conversationId) {
      setLoading(false)
      return
    }

    void fetchLatest(conversationId, true)

    let everSubscribed = false
    const channel = db
      .channel(`direct_messages:${conversationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'direct_messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          const row = payload.new as DirectMessage
          if (activeId.current !== conversationId || row.conversation_id !== conversationId) return
          setMessages((prev) => mergeMessages(prev, [row]))
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'direct_messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          const row = payload.new as DirectMessage
          if (activeId.current !== conversationId || row.conversation_id !== conversationId) return
          setMessages((prev) => mergeMessages(prev, [row]))
        },
      )
      .subscribe((subscribeStatus: string) => {
        if (activeId.current !== conversationId) return
        if (subscribeStatus === 'SUBSCRIBED') {
          setStatus('live')
          // Anything sent while the socket was down is only in the
          // database; pull the newest page and merge it in.
          if (everSubscribed) void fetchLatest(conversationId, false)
          everSubscribed = true
        } else if (subscribeStatus === 'CHANNEL_ERROR' || subscribeStatus === 'TIMED_OUT' || subscribeStatus === 'CLOSED') {
          setStatus('reconnecting')
        }
      })

    return () => {
      activeId.current = undefined
      void db.removeChannel(channel)
    }
  }, [conversationId, fetchLatest])

  // Opening a thread (and any message arriving while it is open) marks
  // incoming messages read - once per change, not on every render.
  const unreadIncoming = currentUserId
    ? messages.filter((m) => m.recipient_id === currentUserId && m.read_at === null).length
    : 0
  useEffect(() => {
    if (!conversationId || unreadIncoming === 0) return
    let cancelled = false
    void (async () => {
      const { error: rpcError } = await db.rpc('mark_direct_conversation_read', { p_conversation_id: conversationId })
      if (!cancelled && !rpcError) onReadRef.current?.()
    })()
    return () => {
      cancelled = true
    }
  }, [conversationId, unreadIncoming])

  const sendMessage = async (body: string) => {
    if (!conversationId || !currentUserId) throw new Error('No conversation open')
    const validated = validateOrThrow(ChatMessageSchema, { message: body })
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new Error("You're offline. Reconnect and try again.")
    }
    const { data, error: insertError } = await db
      .from('direct_messages')
      .insert({ conversation_id: conversationId, sender_id: currentUserId, body: validated.message })
      .select('*')
      .single()
    if (insertError) throw new Error(getErrorMessage(insertError, 'Could not send message'))
    const row = data as DirectMessage
    if (activeId.current === conversationId) setMessages((prev) => mergeMessages(prev, [row]))
    return row
  }

  const loadOlder = async () => {
    if (!conversationId || loadingOlder || messages.length === 0) return
    const id = conversationId
    setLoadingOlder(true)
    try {
      const { data, error: fetchError } = await db
        .from('direct_messages')
        .select('*')
        .eq('conversation_id', id)
        .lt('created_at', messages[0].created_at)
        .order('created_at', { ascending: false })
        .limit(DIRECT_MESSAGE_PAGE_SIZE)
      if (fetchError) throw fetchError
      if (activeId.current !== id) return
      const rows = (data ?? []) as DirectMessage[]
      setMessages((prev) => mergeMessages(prev, rows))
      setHasMore(rows.length === DIRECT_MESSAGE_PAGE_SIZE)
    } catch (err) {
      console.error('Error loading older messages:', err)
    } finally {
      setLoadingOlder(false)
    }
  }

  const refetch = () => (conversationId ? fetchLatest(conversationId, true) : Promise.resolve())

  return { messages, loading, error, hasMore, loadingOlder, status, sendMessage, loadOlder, refetch }
}
