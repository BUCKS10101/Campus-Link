import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { ThemeProvider, useTheme } from 'next-themes'
import { createQueryBuilder, createSupabaseMock } from '@/test/supabaseMock'
import type { ReactNode } from 'react'

type AuthChangeCallback = (event: string, session: unknown) => void

const supabaseMock = {
  ...createSupabaseMock(),
  auth: {
    onAuthStateChange: vi.fn<(cb: AuthChangeCallback) => { data: { subscription: { unsubscribe: () => void } } }>(),
    signUp: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
    updateUser: vi.fn(),
    resetPasswordForEmail: vi.fn(),
  },
}

vi.mock('@/lib/supabase', () => ({
  get supabase() {
    return supabaseMock
  },
}))

const { useAuth, AuthProvider } = await import('./useAuth')

const wrapper = ({ children }: { children: ReactNode }) => (
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
    <AuthProvider>{children}</AuthProvider>
  </ThemeProvider>
)

const useBoth = () => ({ auth: useAuth(), theme: useTheme() })

const emit = (event: string, session: unknown) => {
  supabaseMock.auth.onAuthStateChange.mock.calls.at(-1)?.[0]?.(event, session)
}

const session = (id: string) => ({ user: { id, email: `${id}@vitstudent.ac.in`, email_confirmed_at: '2026-01-01' } })

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  document.documentElement.className = ''
  supabaseMock.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
  supabaseMock.from.mockReturnValue(createQueryBuilder({ data: { id: 'u1', name: 'Jane' }, error: null }))
})

describe('theme and login sessions', () => {
  it('resets a previously chosen dark theme to light on a fresh sign-in', async () => {
    localStorage.setItem('theme', 'dark')
    supabaseMock.auth.signInWithPassword.mockResolvedValue({ data: {}, error: null })
    const { result } = renderHook(useBoth, { wrapper })
    expect(result.current.theme.theme).toBe('dark')

    await act(async () => {
      await result.current.auth.signIn('jane@vitstudent.ac.in', 'password123')
    })
    await waitFor(() => expect(result.current.theme.theme).toBe('light'))
    expect(document.documentElement).not.toHaveClass('dark')
  })

  it('keeps a theme chosen during the session across auth events for the same user (token refresh)', async () => {
    const { result } = renderHook(useBoth, { wrapper })
    act(() => emit('INITIAL_SESSION', session('u1')))
    await waitFor(() => expect(result.current.auth.user).not.toBeNull())

    act(() => result.current.theme.setTheme('dark'))
    act(() => emit('TOKEN_REFRESHED', session('u1')))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(result.current.theme.theme).toBe('dark')
  })

  it('resets to light on logout', async () => {
    supabaseMock.auth.signOut.mockResolvedValue({ error: null })
    const { result } = renderHook(useBoth, { wrapper })
    act(() => result.current.theme.setTheme('dark'))
    expect(result.current.theme.theme).toBe('dark')

    await act(async () => {
      await result.current.auth.signOut()
    })
    await waitFor(() => expect(result.current.theme.theme).toBe('light'))
  })

  it('resets to light when the session ends elsewhere (signed-out event)', async () => {
    const { result } = renderHook(useBoth, { wrapper })
    act(() => result.current.theme.setTheme('dark'))
    act(() => emit('SIGNED_OUT', null))
    await waitFor(() => expect(result.current.theme.theme).toBe('light'))
  })

  it('starts a different account who then signs in on the same browser in light mode', async () => {
    const { result } = renderHook(useBoth, { wrapper })
    act(() => emit('INITIAL_SESSION', session('u1')))
    await waitFor(() => expect(result.current.auth.user).not.toBeNull())
    act(() => result.current.theme.setTheme('dark'))

    act(() => emit('SIGNED_OUT', null))
    act(() => result.current.theme.setTheme('dark'))
    act(() => emit('SIGNED_IN', session('u2')))
    await waitFor(() => expect(result.current.theme.theme).toBe('light'))
  })
})
