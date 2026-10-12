import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { createQueryBuilder, createSupabaseMock } from '@/test/supabaseMock'
import type { DirectMessage } from '@/lib/directMessages'

const supabaseMock = createSupabaseMock()

vi.mock('@/lib/supabase', () => ({
  get supabase() {
    return supabaseMock
  },
}))

const { useDirectMessages } = await import('./useDirectMessages')

const row = (id: string, created_at: string, over: Partial<DirectMessage> = {}): DirectMessage => ({
  id,
  conversation_id: 'c1',
  sender_id: 'friend',
  recipient_id: 'me',
  body: `body ${id}`,
  created_at,
  read_at: null,
  ...over,
})

type Handler = (payload: { new: DirectMessage }) => void
interface FakeChannel {
  name: string
  handlers: Record<string, Handler>
  filters: string[]
  statusCb?: (status: string) => void
}
let channels: FakeChannel[] = []

beforeEach(() => {
  vi.clearAllMocks()
  channels = []
  supabaseMock.channel.mockImplementation(((name: string) => {
    const ch: FakeChannel = { name, handlers: {}, filters: [] }
    channels.push(ch)
    const api = {
      on: (_type: string, opts: { event: string; filter: string }, cb: Handler) => {
        ch.handlers[opts.event] = cb
        ch.filters.push(opts.filter)
        return api
      },
      subscribe: (cb?: (status: string) => void) => {
        ch.statusCb = cb
        return api
      },
    }
    return api
  }) as never)
  supabaseMock.removeChannel.mockResolvedValue('ok')
  supabaseMock.rpc.mockResolvedValue({ data: null, error: null })
})

const stubFrom = (result: { data: unknown; error: { message: string } | null }) => {
  supabaseMock.from.mockReturnValue(createQueryBuilder(result))
}

describe('useDirectMessages', () => {
  it('loads persisted history oldest-first', async () => {
    // The query asks newest-first (so it can page); the hook shows oldest-first.
    stubFrom({ data: [row('m2', '2026-10-13T10:00:02.000Z'), row('m1', '2026-10-13T10:00:01.000Z')], error: null })
    const { result } = renderHook(() => useDirectMessages('c1', 'me'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('subscribes only to this conversation, filtered server-side', async () => {
    stubFrom({ data: [], error: null })
    renderHook(() => useDirectMessages('c1', 'me'))
    await waitFor(() => expect(channels).toHaveLength(1))
    expect(channels[0].filters).toEqual(['conversation_id=eq.c1', 'conversation_id=eq.c1'])
  })

  it('renders an incoming realtime message immediately, with no refetch or refresh', async () => {
    stubFrom({ data: [], error: null })
    const { result } = renderHook(() => useDirectMessages('c1', 'me'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const fromCalls = supabaseMock.from.mock.calls.length

    act(() => channels[0].handlers.INSERT({ new: row('m1', '2026-10-13T10:00:00.000Z') }))

    expect(result.current.messages.map((m) => m.id)).toEqual(['m1'])
    expect(supabaseMock.from.mock.calls.length).toBe(fromCalls)
  })

  it('does not duplicate a sent message when the realtime event for the same row also arrives', async () => {
    const saved = row('m1', '2026-10-13T10:00:00.000Z', { sender_id: 'me', recipient_id: 'friend' })
    stubFrom({ data: [], error: null })
    const { result } = renderHook(() => useDirectMessages('c1', 'me'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    supabaseMock.from.mockReturnValue(createQueryBuilder({ data: saved, error: null }))
    await act(async () => {
      await result.current.sendMessage('hello')
    })
    act(() => channels[0].handlers.INSERT({ new: saved }))

    expect(result.current.messages).toHaveLength(1)
  })

  it('does not add a message when the insert is rejected (nothing is shown unless it persisted)', async () => {
    stubFrom({ data: [], error: null })
    const { result } = renderHook(() => useDirectMessages('c1', 'me'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    supabaseMock.from.mockReturnValue(
      createQueryBuilder({ data: null, error: { message: 'You can only message accepted friends' } }),
    )
    await expect(
      act(async () => {
        await result.current.sendMessage('hi')
      }),
    ).rejects.toThrow(/accepted friends/)
    expect(result.current.messages).toEqual([])
  })

  it('refuses to send while the browser is offline, without touching the database', async () => {
    stubFrom({ data: [], error: null })
    const { result } = renderHook(() => useDirectMessages('c1', 'me'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const fromCalls = supabaseMock.from.mock.calls.length

    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await expect(
      act(async () => {
        await result.current.sendMessage('hi')
      }),
    ).rejects.toThrow(/offline/i)
    expect(supabaseMock.from.mock.calls.length).toBe(fromCalls)
    spy.mockRestore()
  })

  it('ignores an event that belongs to a different conversation', async () => {
    stubFrom({ data: [], error: null })
    const { result } = renderHook(() => useDirectMessages('c1', 'me'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => channels[0].handlers.INSERT({ new: row('x1', '2026-10-13T10:00:00.000Z', { conversation_id: 'other' }) }))
    expect(result.current.messages).toEqual([])
  })

  it('removes the channel on unmount and when switching conversations - no stale listeners', async () => {
    stubFrom({ data: [], error: null })
    const { result, rerender, unmount } = renderHook(({ id }) => useDirectMessages(id, 'me'), {
      initialProps: { id: 'c1' },
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(channels).toHaveLength(1)

    rerender({ id: 'c2' })
    await waitFor(() => expect(channels).toHaveLength(2))
    expect(supabaseMock.removeChannel).toHaveBeenCalledTimes(1)
    expect(channels[1].filters[0]).toBe('conversation_id=eq.c2')

    // A late event from the old channel's handler must not land in c2.
    act(() => channels[0].handlers.INSERT({ new: row('late', '2026-10-13T10:00:00.000Z', { conversation_id: 'c1' }) }))
    expect(result.current.messages).toEqual([])

    unmount()
    expect(supabaseMock.removeChannel).toHaveBeenCalledTimes(2)
  })

  it('re-syncs from the database after a reconnect so missed messages appear', async () => {
    stubFrom({ data: [], error: null })
    const { result } = renderHook(() => useDirectMessages('c1', 'me'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => channels[0].statusCb?.('SUBSCRIBED'))
    expect(result.current.status).toBe('live')

    act(() => channels[0].statusCb?.('CHANNEL_ERROR'))
    expect(result.current.status).toBe('reconnecting')

    stubFrom({ data: [row('missed', '2026-10-13T10:00:00.000Z')], error: null })
    act(() => channels[0].statusCb?.('SUBSCRIBED'))
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['missed']))
  })

  it('marks incoming unread messages read once the thread shows them', async () => {
    stubFrom({ data: [row('m1', '2026-10-13T10:00:00.000Z')], error: null })
    const onRead = vi.fn()
    renderHook(() => useDirectMessages('c1', 'me', onRead))
    await waitFor(() =>
      expect(supabaseMock.rpc).toHaveBeenCalledWith('mark_direct_conversation_read', { p_conversation_id: 'c1' }),
    )
    await waitFor(() => expect(onRead).toHaveBeenCalled())
  })

  it('does not mark anything read for messages the user sent', async () => {
    stubFrom({ data: [row('m1', '2026-10-13T10:00:00.000Z', { sender_id: 'me', recipient_id: 'friend' })], error: null })
    const { result } = renderHook(() => useDirectMessages('c1', 'me'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(supabaseMock.rpc).not.toHaveBeenCalled()
  })

  it('surfaces a load error rather than an empty thread', async () => {
    stubFrom({ data: null, error: { message: 'permission denied for table direct_messages' } })
    const { result } = renderHook(() => useDirectMessages('c-not-mine', 'me'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toMatch(/permission denied/i)
  })
})
