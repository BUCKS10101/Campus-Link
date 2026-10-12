import { useCallback, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { untypedSupabase } from '@/lib/directMessages'
import type { FriendshipWithProfiles, SearchProfileResult } from '@/lib/database-types'
import { getErrorMessage } from '@/lib/utils'

const FRIENDSHIP_COLUMNS = `
  id, requester_id, addressee_id, status, created_at,
  requester_profile:profiles!friendships_requester_id_fkey(*),
  addressee_profile:profiles!friendships_addressee_id_fkey(*)
`

/**
 * Phase 3E - see PHASE3_3E_SOCIAL_GRAPH_SPEC.md. A plain hook, not a
 * context provider - same reasoning as useRatings.ts: nothing here
 * needs app-wide shared state or a realtime subscription (a new pending
 * request already surfaces via the existing 3C notification channel).
 */
export const useFriends = () => {
  const [loading, setLoading] = useState(false)

  /** One query, split into three buckets client-side - see spec §8. */
  const fetchMyFriendships = async (userId: string): Promise<{
    friends: FriendshipWithProfiles[]
    received: FriendshipWithProfiles[]
    sent: FriendshipWithProfiles[]
  }> => {
    const { data, error } = await supabase
      .from('friendships')
      .select(FRIENDSHIP_COLUMNS)
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
      .order('created_at', { ascending: false })

    if (error) return { friends: [], received: [], sent: [] }

    const rows = (data ?? []) as unknown as FriendshipWithProfiles[]
    return {
      friends: rows.filter((r) => r.status === 'accepted'),
      received: rows.filter((r) => r.status === 'pending' && r.addressee_id === userId),
      sent: rows.filter((r) => r.status === 'pending' && r.requester_id === userId),
    }
  }

  /**
   * Phase 3F - a lean id-only query for Home's "Recommended" ranking
   * (see PHASE3_3F_SMART_MATCHING_SPEC.md §11/§12), deliberately not
   * fetchMyFriendships: that one joins full profile rows for the
   * Friends page and would over-fetch for a ranking signal that only
   * ever needs "which ids are my accepted friends." One query, no
   * profile embed, only accepted relationships (a pending request isn't
   * a friend yet for this purpose).
   */
  const fetchAcceptedFriendIds = async (userId: string): Promise<Set<string>> => {
    const { data, error } = await supabase
      .from('friendships')
      .select('requester_id, addressee_id')
      .eq('status', 'accepted')
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)

    if (error) return new Set()

    const rows = (data ?? []) as { requester_id: string; addressee_id: string }[]
    return new Set(rows.map((r) => (r.requester_id === userId ? r.addressee_id : r.requester_id)))
  }

  // Stable across renders (empty deps: closes only over the module-level
  // supabase client, never component state) - FindStudents' debounce
  // effect in Friends.tsx depends on this directly, and an unstable
  // reference here would re-fire that effect on every render, not just
  // on a real query change.
  const searchProfiles = useCallback(async (query: string): Promise<SearchProfileResult[]> => {
    const trimmed = query.trim()
    if (!trimmed) return []
    const { data, error } = await supabase.rpc('search_profiles', { p_query: trimmed })
    if (error) return []
    return (data ?? []) as unknown as SearchProfileResult[]
  }, [])

  const withLoading = async <T,>(fn: () => Promise<T>): Promise<T> => {
    setLoading(true)
    try {
      return await fn()
    } finally {
      setLoading(false)
    }
  }

  const sendFriendRequest = (addresseeId: string) => withLoading(async () => {
    const { data, error } = await supabase.rpc('send_friend_request', { p_addressee_id: addresseeId })
    if (error) throw new Error(getErrorMessage(error, 'Could not send friend request'))
    return data as unknown as string
  })

  const acceptFriendRequest = (friendshipId: string) => withLoading(async () => {
    const { error } = await supabase.rpc('accept_friend_request', { p_friendship_id: friendshipId })
    if (error) throw new Error(getErrorMessage(error, 'Could not accept request'))
  })

  const declineFriendRequest = (friendshipId: string) => withLoading(async () => {
    const { error } = await supabase.rpc('decline_friend_request', { p_friendship_id: friendshipId })
    if (error) throw new Error(getErrorMessage(error, 'Could not decline request'))
  })

  const cancelFriendRequest = (friendshipId: string) => withLoading(async () => {
    const { error } = await supabase.rpc('cancel_friend_request', { p_friendship_id: friendshipId })
    if (error) throw new Error(getErrorMessage(error, 'Could not cancel request'))
  })

  /** Finds or creates the single direct conversation with an accepted friend; returns its id. */
  const openConversationWith = (friendId: string) => withLoading(async () => {
    const { data, error } = await untypedSupabase.rpc('get_or_create_direct_conversation', { p_friend_id: friendId })
    if (error) throw new Error(getErrorMessage(error, 'Could not open conversation'))
    return data as unknown as string
  })

  const removeFriend = (friendshipId: string) => withLoading(async () => {
    const { error } = await supabase.rpc('remove_friend', { p_friendship_id: friendshipId })
    if (error) throw new Error(getErrorMessage(error, 'Could not remove friend'))
  })

  return {
    loading,
    fetchMyFriendships,
    fetchAcceptedFriendIds,
    searchProfiles,
    sendFriendRequest,
    acceptFriendRequest,
    declineFriendRequest,
    cancelFriendRequest,
    removeFriend,
    openConversationWith,
  }
}
