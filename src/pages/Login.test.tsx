import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

const mockToast = vi.fn()
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

const mockSignIn = vi.fn()
const mockSignUp = vi.fn()
const mockSendPasswordResetEmail = vi.fn()
const mockUseAuth = vi.fn()
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}))

const { default: Login } = await import('./Login')

const renderLogin = () => render(<MemoryRouter><Login /></MemoryRouter>)

const fillLogin = async (email: string, password: string) => {
  await userEvent.type(screen.getByLabelText(/email/i), email)
  await userEvent.type(screen.getByLabelText(/password/i), password)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUseAuth.mockReturnValue({ user: null, signIn: mockSignIn, signUp: mockSignUp, sendPasswordResetEmail: mockSendPasswordResetEmail })
})

describe('Login', () => {
  it('is interactive on first render — the button is not gated on auth-session loading', () => {
    renderLogin()
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeEnabled()
  })

  it('enters a loading state on submit and leaves it once sign-in resolves', async () => {
    let resolveSignIn: (v: unknown) => void
    mockSignIn.mockReturnValue(new Promise((resolve) => { resolveSignIn = resolve }))
    renderLogin()

    await fillLogin('a@vitstudent.ac.in', 'password123')
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeDisabled()

    resolveSignIn!({ user: { id: 'u1' } })
    await waitFor(() => expect(screen.getByRole('button', { name: /^sign in$/i })).toBeEnabled())
  })

  it('leaves the loading state and stays interactive on invalid credentials', async () => {
    mockSignIn.mockRejectedValue(new Error('Invalid login credentials'))
    renderLogin()

    await fillLogin('a@vitstudent.ac.in', 'wrong-password')
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /^sign in$/i })).toBeEnabled())
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/didn't work/i) })
    )
  })

  it('leaves the loading state and stays interactive when sign-in rejects unexpectedly', async () => {
    mockSignIn.mockRejectedValue(new Error('Network request failed'))
    renderLogin()

    await fillLogin('a@vitstudent.ac.in', 'password123')
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /^sign in$/i })).toBeEnabled())
  })

  it('does not require a manual navigate — reaches the app once the auth hook reports a user', () => {
    const { rerender } = render(<MemoryRouter><Login /></MemoryRouter>)
    expect(mockNavigate).not.toHaveBeenCalled()

    mockUseAuth.mockReturnValue({ user: { user: { id: 'u1' } }, signIn: mockSignIn, signUp: mockSignUp })
    rerender(<MemoryRouter><Login /></MemoryRouter>)

    expect(mockNavigate).toHaveBeenCalledWith('/')
  })

  it('blocks submission with a toast when required fields are missing, without ever entering a loading state', async () => {
    renderLogin()
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(mockSignIn).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/missing information/i) })
    )
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeEnabled()
  })

  // Phase 3J - see PHASE3_3J_TRUST_SAFETY_SPEC.md §2. A fresh signUp()
  // navigates straight to /verify-email, NOT the generic user-truthy
  // effect's '/' - that effect would otherwise race this explicit
  // navigate the instant useAuth's mocked `user` value changes.
  describe('register (Phase 3J)', () => {
    const fillRegister = async (email: string, phone: string, password: string) => {
      await userEvent.click(screen.getByRole('button', { name: /^register$/i }))
      await userEvent.type(screen.getByLabelText(/full name/i), 'Jane Doe')
      await userEvent.type(screen.getByLabelText(/email/i), email)
      await userEvent.type(screen.getByLabelText(/phone number/i), phone)
      await userEvent.type(screen.getByLabelText(/password/i), password)
    }

    it('navigates to /verify-email after a successful signUp, not "/"', async () => {
      mockSignUp.mockResolvedValue({ user: { id: 'u1' } })
      const { rerender } = render(<MemoryRouter><Login /></MemoryRouter>)

      await fillRegister('jane@vitstudent.ac.in', '9876543210', 'password123')
      await userEvent.click(screen.getByRole('button', { name: /create account/i }))

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/verify-email'))
      expect(mockNavigate).not.toHaveBeenCalledWith('/')

      // Even if the auth hook's `user` now flips truthy on the next
      // render (as the real useAuth would once the session lands), the
      // generic redirect effect must not also fire '/' - the ref guard
      // is what prevents that race.
      mockUseAuth.mockReturnValue({ user: { user: { id: 'u1' } }, signIn: mockSignIn, signUp: mockSignUp })
      rerender(<MemoryRouter><Login /></MemoryRouter>)
      expect(mockNavigate).not.toHaveBeenCalledWith('/')
    })

    it('re-arms the generic redirect if signUp itself fails', async () => {
      mockSignUp.mockRejectedValue(new Error('Only @vitstudent.ac.in email addresses may register'))
      const { rerender } = render(<MemoryRouter><Login /></MemoryRouter>)

      await fillRegister('jane@vitstudent.ac.in', '9876543210', 'password123')
      await userEvent.click(screen.getByRole('button', { name: /create account/i }))

      await waitFor(() => expect(screen.getByRole('button', { name: /create account/i })).toBeEnabled())
      expect(mockNavigate).not.toHaveBeenCalledWith('/verify-email')

      mockUseAuth.mockReturnValue({ user: { user: { id: 'u1' } }, signIn: mockSignIn, signUp: mockSignUp })
      rerender(<MemoryRouter><Login /></MemoryRouter>)
      expect(mockNavigate).toHaveBeenCalledWith('/')
    })
  })

  describe('forgot password (QA audit AUTH-09)', () => {
    it('is reachable from the sign-in screen', async () => {
      renderLogin()
      expect(screen.getByRole('button', { name: /forgot password\?/i })).toBeInTheDocument()
    })

    it('switches to a single-email form, hiding the password field', async () => {
      renderLogin()
      await userEvent.click(screen.getByRole('button', { name: /forgot password\?/i }))

      expect(screen.getByText(/forgot your password/i)).toBeInTheDocument()
      expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument()
    })

    it('sends the reset email and shows the same confirmation regardless of whether the account exists', async () => {
      mockSendPasswordResetEmail.mockResolvedValue(undefined)
      renderLogin()
      await userEvent.click(screen.getByRole('button', { name: /forgot password\?/i }))
      await userEvent.type(screen.getByLabelText(/email/i), 'jane@vitstudent.ac.in')
      await userEvent.click(screen.getByRole('button', { name: /send reset link/i }))

      await waitFor(() => expect(mockSendPasswordResetEmail).toHaveBeenCalledWith('jane@vitstudent.ac.in'))
      expect(await screen.findByText(/reset link is on its way/i)).toBeInTheDocument()
    })

    it('surfaces a real send failure as a destructive toast', async () => {
      mockSendPasswordResetEmail.mockRejectedValue(new Error('Rate limited'))
      renderLogin()
      await userEvent.click(screen.getByRole('button', { name: /forgot password\?/i }))
      await userEvent.type(screen.getByLabelText(/email/i), 'jane@vitstudent.ac.in')
      await userEvent.click(screen.getByRole('button', { name: /send reset link/i }))

      await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/couldn.t send reset link/i), variant: 'destructive' })
      ))
    })

    it('returns to the sign-in form via "Back to sign in"', async () => {
      renderLogin()
      await userEvent.click(screen.getByRole('button', { name: /forgot password\?/i }))
      await userEvent.click(screen.getByRole('button', { name: /back to sign in/i }))

      expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument()
      expect(screen.getByLabelText(/password/i)).toBeInTheDocument()
    })
  })
})
