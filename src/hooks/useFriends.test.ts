import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createSupabaseMock } from '@/test/supabaseMock'

const supabaseMock = createSupabaseMock()
vi.mock('@/lib/supabase', () => ({
  get supabase() {
    return supabaseMock
  },
}))

const { useFriends } = await import('./useFriends')

beforeEach(() => {
  vi.clearAllMocks()
})

const FRIENDSHIP_ACCEPTED = {
  id: 'f1', requester_id: 'me', addressee_id: 'other-1', status: 'accepted', created_at: '2026-08-28T10:00:00.000Z',
  requester_profile: { id: 'me', name: 'Me' },
  addressee_profile: { id: 'other-1', name: 'Alice' },
}
const FRIENDSHIP_RECEIVED = {
  id: 'f2', requester_id: 'other-2', addressee_id: 'me', status: 'pending', created_at: '2026-08-28T10:00:00.000Z',
  requester_profile: { id: 'other-2', name: 'Bob' },
  addressee_profile: { id: 'me', name: 'Me' },
}
const FRIENDSHIP_SENT = {
  id: 'f3', requester_id: 'me', addressee_id: 'other-3', status: 'pending', created_at: '2026-08-28T10:00:00.000Z',
  requester_profile: { id: 'me', name: 'Me' },
  addressee_profile: { id: 'other-3', name: 'Carol' },
}

describe('useFriends - fetchMyFriendships', () => {
  it('splits one query into friends/received/sent buckets', async () => {
    supabaseMock.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [FRIENDSHIP_ACCEPTED, FRIENDSHIP_RECEIVED, FRIENDSHIP_SENT],
        error: null,
      }),
    })
    const { result } = renderHook(() => useFriends())

    const { friends, received, sent } = await result.current.fetchMyFriendships('me')
    expect(friends).toEqual([FRIENDSHIP_ACCEPTED])
    expect(received).toEqual([FRIENDSHIP_RECEIVED])
    expect(sent).toEqual([FRIENDSHIP_SENT])
    expect(supabaseMock.from).toHaveBeenCalledWith('friendships')
  })

  it('returns empty buckets on a query error instead of throwing', async () => {
    supabaseMock.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: null, error: { message: 'network error' } }),
    })
    const { result } = renderHook(() => useFriends())

    const { friends, received, sent } = await result.current.fetchMyFriendships('me')
    expect(friends).toEqual([])
    expect(received).toEqual([])
    expect(sent).toEqual([])
  })
})

describe('useFriends - fetchAcceptedFriendIds (Phase 3F)', () => {
  it('returns the other participant id for each accepted friendship, in either direction', async () => {
    supabaseMock.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      or: vi.fn().mockResolvedValue({
        data: [
          { requester_id: 'me', addressee_id: 'friend-1' },
          { requester_id: 'friend-2', addressee_id: 'me' },
        ],
        error: null,
      }),
    })
    const { result } = renderHook(() => useFriends())

    const ids = await result.current.fetchAcceptedFriendIds('me')
    expect(ids).toEqual(new Set(['friend-1', 'friend-2']))
  })

  it('scopes the query to accepted relationships only', async () => {
    const eqMock = vi.fn().mockReturnThis()
    supabaseMock.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: eqMock,
      or: vi.fn().mockResolvedValue({ data: [], error: null }),
    })
    const { result } = renderHook(() => useFriends())

    await result.current.fetchAcceptedFriendIds('me')
    expect(eqMock).toHaveBeenCalledWith('status', 'accepted')
  })

  it('returns an empty set on a query error instead of throwing', async () => {
    supabaseMock.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      or: vi.fn().mockResolvedValue({ data: null, error: { message: 'network error' } }),
    })
    const { result } = renderHook(() => useFriends())

    const ids = await result.current.fetchAcceptedFriendIds('me')
    expect(ids).toEqual(new Set())
  })
})

describe('useFriends - searchProfiles', () => {
  it('calls search_profiles with the trimmed query', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: [{ id: 'x', name: 'Alice', avg_rating: null, rating_count: 0, relationship: 'none' }], error: null })
    const { result } = renderHook(() => useFriends())

    const results = await result.current.searchProfiles('  Alice  ')
    expect(supabaseMock.rpc).toHaveBeenCalledWith('search_profiles', { p_query: 'Alice' })
    expect(results).toHaveLength(1)
  })

  it('returns an empty array for a blank query without calling the RPC', async () => {
    const { result } = renderHook(() => useFriends())
    const results = await result.current.searchProfiles('   ')
    expect(results).toEqual([])
    expect(supabaseMock.rpc).not.toHaveBeenCalled()
  })

  it('returns an empty array on error instead of throwing', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: null, error: { message: 'network error' } })
    const { result } = renderHook(() => useFriends())
    const results = await result.current.searchProfiles('Alice')
    expect(results).toEqual([])
  })
})

describe('useFriends - write operations', () => {
  it('sendFriendRequest calls send_friend_request with the addressee id', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: 'new-friendship-id', error: null })
    const { result } = renderHook(() => useFriends())

    const id = await result.current.sendFriendRequest('other-1')
    expect(supabaseMock.rpc).toHaveBeenCalledWith('send_friend_request', { p_addressee_id: 'other-1' })
    expect(id).toBe('new-friendship-id')
  })

  it('surfaces the server rejection message (e.g. duplicate/self-request)', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: null, error: { message: 'A relationship with this student already exists' } })
    const { result } = renderHook(() => useFriends())
    await expect(result.current.sendFriendRequest('other-1')).rejects.toThrow(/already exists/i)
  })

  it('acceptFriendRequest/declineFriendRequest/cancelFriendRequest/removeFriend each call the matching RPC by friendship id', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: null, error: null })
    const { result } = renderHook(() => useFriends())

    await result.current.acceptFriendRequest('f1')
    expect(supabaseMock.rpc).toHaveBeenCalledWith('accept_friend_request', { p_friendship_id: 'f1' })

    await result.current.declineFriendRequest('f2')
    expect(supabaseMock.rpc).toHaveBeenCalledWith('decline_friend_request', { p_friendship_id: 'f2' })

    await result.current.cancelFriendRequest('f3')
    expect(supabaseMock.rpc).toHaveBeenCalledWith('cancel_friend_request', { p_friendship_id: 'f3' })

    await result.current.removeFriend('f4')
    expect(supabaseMock.rpc).toHaveBeenCalledWith('remove_friend', { p_friendship_id: 'f4' })
  })

  it('tracks a loading flag across a write call', async () => {
    let resolveRpc: (v: unknown) => void = () => {}
    supabaseMock.rpc.mockReturnValue(new Promise((resolve) => { resolveRpc = resolve }))
    const { result } = renderHook(() => useFriends())

    expect(result.current.loading).toBe(false)
    let promise: Promise<unknown>
    act(() => {
      promise = result.current.sendFriendRequest('other-1')
    })
    await waitFor(() => expect(result.current.loading).toBe(true))

    resolveRpc({ data: 'id', error: null })
    await act(async () => {
      await promise
    })
    expect(result.current.loading).toBe(false)
  })
})

describe('useFriends - openConversationWith', () => {
  it('asks the server for the single conversation with a friend and returns its id', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: 'conv-1', error: null })
    const { result } = renderHook(() => useFriends())

    const first = await result.current.openConversationWith('other-1')
    const second = await result.current.openConversationWith('other-1')

    expect(supabaseMock.rpc).toHaveBeenCalledWith('get_or_create_direct_conversation', { p_friend_id: 'other-1' })
    expect(first).toBe('conv-1')
    expect(second).toBe('conv-1')
  })

  it('surfaces the server rejection for someone who is not (or is no longer) a friend', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: null, error: { message: 'You can only message accepted friends' } })
    const { result } = renderHook(() => useFriends())
    await expect(result.current.openConversationWith('stranger')).rejects.toThrow(/accepted friends/)
  })
})
