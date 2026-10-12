import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { createSupabaseMock } from '@/test/supabaseMock'
import type { ReactNode } from 'react'

const supabaseMock = createSupabaseMock()
vi.mock('@/lib/supabase', () => ({
  get supabase() {
    return supabaseMock
  },
}))

let mockUser: { user: { id: string } } | null = { user: { id: 'me' } }
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser }) }))

const { ConversationsProvider, useConversations } = await import('./useConversations')

const wrapper = ({ children }: { children: ReactNode }) => <ConversationsProvider>{children}</ConversationsProvider>

const summary = (id: string, unread: number) => ({
  conversation_id: id,
  friend_id: `f-${id}`,
  friend_name: `Friend ${id}`,
  last_message: 'hi',
  last_message_at: '2026-10-13T10:00:00Z',
  last_sender_id: `f-${id}`,
  unread_count: unread,
  can_message: true,
})

let filters: string[] = []
let insertHandler: (() => void) | undefined

beforeEach(() => {
  vi.clearAllMocks()
  mockUser = { user: { id: 'me' } }
  filters = []
  insertHandler = undefined
  supabaseMock.channel.mockImplementation((() => {
    const api = {
      on: (_t: string, opts: { filter: string }, cb: () => void) => {
        filters.push(opts.filter)
        insertHandler = cb
        return api
      },
      subscribe: () => api,
    }
    return api
  }) as never)
  supabaseMock.removeChannel.mockResolvedValue('ok')
})

describe('ConversationsProvider', () => {
  it('sums unread across conversations for the nav badge', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: [summary('a', 2), summary('b', 3)], error: null })
    const { result } = renderHook(() => useConversations(), { wrapper })
    await waitFor(() => expect(result.current.totalUnread).toBe(5))
  })

  it('subscribes only to messages addressed to the signed-in user, and cleans up on unmount', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: [], error: null })
    const { unmount } = renderHook(() => useConversations(), { wrapper })
    await waitFor(() => expect(filters).toEqual(['recipient_id=eq.me']))
    unmount()
    expect(supabaseMock.removeChannel).toHaveBeenCalledTimes(1)
  })

  it('re-fetches the summary when a new message arrives, without polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    supabaseMock.rpc.mockResolvedValue({ data: [], error: null })
    const { result } = renderHook(() => useConversations(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    const calls = supabaseMock.rpc.mock.calls.length

    supabaseMock.rpc.mockResolvedValue({ data: [summary('a', 1)], error: null })
    act(() => insertHandler?.())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    await waitFor(() => expect(result.current.totalUnread).toBe(1))
    expect(supabaseMock.rpc.mock.calls.length).toBe(calls + 1)
    vi.useRealTimers()
  })

  it('starts (or reuses) a conversation through the server RPC and returns the same id each time', async () => {
    supabaseMock.rpc.mockImplementation(async (fn: string) =>
      fn === 'get_or_create_direct_conversation' ? { data: 'conv-1', error: null } : { data: [], error: null })
    const { result } = renderHook(() => useConversations(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    const first = await result.current.startConversation('friend-1')
    const second = await result.current.startConversation('friend-1')
    expect(first).toBe('conv-1')
    expect(second).toBe('conv-1')
    expect(supabaseMock.rpc).toHaveBeenCalledWith('get_or_create_direct_conversation', { p_friend_id: 'friend-1' })
  })

  it('rejects starting a conversation with a non-friend using the server error', async () => {
    supabaseMock.rpc.mockImplementation(async (fn: string) =>
      fn === 'get_or_create_direct_conversation'
        ? { data: null, error: { message: 'You can only message accepted friends' } }
        : { data: [], error: null })
    const { result } = renderHook(() => useConversations(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await expect(result.current.startConversation('stranger')).rejects.toThrow(/accepted friends/)
  })

  it('does nothing when signed out', async () => {
    mockUser = null
    renderHook(() => useConversations(), { wrapper })
    expect(supabaseMock.rpc).not.toHaveBeenCalled()
    expect(supabaseMock.channel).not.toHaveBeenCalled()
  })
})
