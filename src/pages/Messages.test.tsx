import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Messages from './Messages'

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { user: { id: 'me' }, emailVerified: true } }),
}))
vi.mock('@/components/chat/DirectThread', () => ({
  DirectThread: ({ friendName }: { friendName: string }) => <div>thread with {friendName}</div>,
}))

const summary = {
  conversation_id: 'c-new',
  friend_id: 'f1',
  friend_name: 'Asha',
  last_message: null,
  last_message_at: null,
  last_sender_id: null,
  unread_count: 0,
  can_message: true,
}

let conversations: unknown[] = []
const refresh = vi.fn()
vi.mock('@/hooks/useConversations', () => ({
  useConversations: () => ({ conversations, loading: false, refresh, totalUnread: 0, startConversation: vi.fn() }),
}))

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/messages" element={<Messages />} />
        <Route path="/messages/:conversationId" element={<Messages />} />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  conversations = []
})

describe('Messages', () => {
  it('opens a brand-new conversation the list has not heard about yet (the Message button case)', async () => {
    // The list is stale on arrival; reloading it surfaces the new conversation.
    refresh.mockImplementation(async () => {
      conversations = [summary]
    })
    const { rerender } = renderAt('/messages/c-new')
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    rerender(
      <MemoryRouter initialEntries={['/messages/c-new']}>
        <Routes>
          <Route path="/messages/:conversationId" element={<Messages />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('thread with Asha')).toBeInTheDocument()
  })

  it('only says a conversation is unavailable after reloading the list and still not finding it', async () => {
    refresh.mockResolvedValue(undefined)
    renderAt('/messages/not-mine')
    expect(await screen.findByText(/isn't available/i)).toBeInTheDocument()
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
