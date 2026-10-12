import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DirectThread } from './DirectThread'

const mockHook = vi.fn()
vi.mock('@/hooks/useDirectMessages', () => ({
  useDirectMessages: (...args: unknown[]) => mockHook(...args),
}))
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const base = {
  messages: [],
  loading: false,
  error: null,
  hasMore: false,
  loadingOlder: false,
  status: 'live',
  sendMessage: vi.fn(),
  loadOlder: vi.fn(),
  refetch: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockHook.mockReturnValue({ ...base })
})

const props = { conversationId: 'c1', currentUserId: 'me', friendName: 'Asha', canMessage: true }

describe('DirectThread', () => {
  it('shows an empty-conversation prompt', () => {
    render(<DirectThread {...props} />)
    expect(screen.getByText(/start of your chat with Asha/i)).toBeInTheDocument()
  })

  it('distinguishes sent from received messages and shows read status on sent ones', () => {
    mockHook.mockReturnValue({
      ...base,
      messages: [
        { id: '1', conversation_id: 'c1', sender_id: 'friend', recipient_id: 'me', body: 'hey', created_at: '2026-10-13T10:00:00Z', read_at: null },
        { id: '2', conversation_id: 'c1', sender_id: 'me', recipient_id: 'friend', body: 'hello', created_at: '2026-10-13T10:01:00Z', read_at: '2026-10-13T10:02:00Z' },
      ],
    })
    render(<DirectThread {...props} />)
    expect(screen.getAllByTestId('dm-received')).toHaveLength(1)
    expect(screen.getAllByTestId('dm-sent')).toHaveLength(1)
    expect(screen.getByText(/· Read/)).toBeInTheDocument()
  })

  it('sends the draft and clears it on success', async () => {
    const sendMessage = vi.fn().mockResolvedValue({})
    mockHook.mockReturnValue({ ...base, sendMessage })
    render(<DirectThread {...props} />)
    await userEvent.type(screen.getByLabelText('Message'), 'hi there')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(sendMessage).toHaveBeenCalledWith('hi there')
    expect(screen.getByLabelText('Message')).toHaveValue('')
  })

  it('keeps the draft when sending fails so it can be retried', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('offline'))
    mockHook.mockReturnValue({ ...base, sendMessage })
    render(<DirectThread {...props} />)
    await userEvent.type(screen.getByLabelText('Message'), 'keep me')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByLabelText('Message')).toHaveValue('keep me')
  })

  it('is read-only once the friendship is gone: history visible, composer disabled', () => {
    mockHook.mockReturnValue({
      ...base,
      messages: [{ id: '1', conversation_id: 'c1', sender_id: 'friend', recipient_id: 'me', body: 'old message', created_at: '2026-10-13T10:00:00Z', read_at: null }],
    })
    render(<DirectThread {...props} canMessage={false} />)
    expect(screen.getByText('old message')).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByText(/only message accepted friends/i)).toBeInTheDocument()
  })

  it('offers older history for long conversations', async () => {
    const loadOlder = vi.fn()
    mockHook.mockReturnValue({ ...base, hasMore: true, loadOlder })
    render(<DirectThread {...props} />)
    await userEvent.click(screen.getByRole('button', { name: /earlier messages/i }))
    expect(loadOlder).toHaveBeenCalled()
  })

  it('shows a retryable error state', async () => {
    const refetch = vi.fn()
    mockHook.mockReturnValue({ ...base, error: 'Failed to load messages', refetch })
    render(<DirectThread {...props} />)
    expect(screen.getByText('Failed to load messages')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refetch).toHaveBeenCalled()
  })
})
