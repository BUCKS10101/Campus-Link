import { supabase } from '@/lib/supabase'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The generated Database type does not describe the direct-message tables
 * or RPCs (it is already out of date for several other RPCs), so this
 * module's callers use the untyped client and the row types below.
 */
export const untypedSupabase = supabase as unknown as SupabaseClient

export interface DirectMessage {
  id: string
  conversation_id: string
  sender_id: string
  recipient_id: string
  body: string
  created_at: string
  read_at: string | null
}

export interface DirectConversationSummary {
  conversation_id: string
  friend_id: string
  friend_name: string
  last_message: string | null
  last_message_at: string | null
  last_sender_id: string | null
  unread_count: number
  can_message: boolean
}

export const DIRECT_MESSAGE_PAGE_SIZE = 50

/**
 * Merges incoming rows into an existing list: de-duplicated by id (the
 * database row is the single source of truth, so an insert response and
 * the realtime event for the same row collapse into one), newer data for
 * an id wins (a read_at update replaces the earlier copy), and the result
 * is always chronological.
 */
export function mergeMessages(existing: DirectMessage[], incoming: DirectMessage[]): DirectMessage[] {
  if (incoming.length === 0) return existing
  const byId = new Map<string, DirectMessage>()
  for (const m of existing) byId.set(m.id, m)
  for (const m of incoming) byId.set(m.id, { ...byId.get(m.id), ...m })
  return [...byId.values()].sort((a, b) => {
    // Compared as instants, not strings: Postgres trims trailing zeros
    // from fractional seconds, so ISO strings do not sort lexically.
    const t = Date.parse(a.created_at) - Date.parse(b.created_at)
    return t !== 0 ? t : a.id.localeCompare(b.id)
  })
}
