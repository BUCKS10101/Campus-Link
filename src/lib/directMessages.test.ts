import { describe, it, expect } from 'vitest'
import { mergeMessages, type DirectMessage } from './directMessages'

const msg = (id: string, created_at: string, extra: Partial<DirectMessage> = {}): DirectMessage => ({
  id,
  conversation_id: 'c1',
  sender_id: 'a',
  recipient_id: 'b',
  body: id,
  created_at,
  read_at: null,
  ...extra,
})

describe('mergeMessages', () => {
  it('collapses the same row arriving twice (insert response + realtime event) into one', () => {
    const row = msg('m1', '2026-10-13T10:00:00.000Z')
    const merged = mergeMessages(mergeMessages([], [row]), [{ ...row }])
    expect(merged).toHaveLength(1)
  })

  it('keeps messages chronological regardless of arrival order', () => {
    const merged = mergeMessages(
      [msg('m2', '2026-10-13T10:00:02.000Z')],
      [msg('m3', '2026-10-13T10:00:03.000Z'), msg('m1', '2026-10-13T10:00:01.000Z')],
    )
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('orders by instant, not string - Postgres trims trailing zeros from fractional seconds', () => {
    const merged = mergeMessages([], [
      msg('late', '2026-10-13T10:00:00.5+00:00'),
      msg('early', '2026-10-13T10:00:00.123456+00:00'),
    ])
    expect(merged.map((m) => m.id)).toEqual(['early', 'late'])
  })

  it('applies a later update (read receipt) to an existing row instead of duplicating it', () => {
    const merged = mergeMessages(
      [msg('m1', '2026-10-13T10:00:00.000Z')],
      [msg('m1', '2026-10-13T10:00:00.000Z', { read_at: '2026-10-13T10:05:00.000Z' })],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].read_at).toBe('2026-10-13T10:05:00.000Z')
  })

  it('returns the same array when nothing is incoming', () => {
    const existing = [msg('m1', '2026-10-13T10:00:00.000Z')]
    expect(mergeMessages(existing, [])).toBe(existing)
  })
})
