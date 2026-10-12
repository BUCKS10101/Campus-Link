import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ProtectedRoute from '@/components/ProtectedRoute'
import { AppShell } from './AppShell'

const mockUseAuth = vi.fn()
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}))

// AppShell now renders NotificationBell (desktop nav + mobile header) and
// MobileNav reads unreadCount for the Activity tab's dot - neither is
// under test here, so a fixed empty/zero result keeps this file focused
// on shell/nav behavior.
vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: () => ({
    notifications: [],
    unreadCount: 0,
    loading: false,
    hasMore: false,
    loadMore: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    markOrderChatRead: vi.fn(),
  }),
}))

// The header's Messages link reads the unread total from the conversations
// context - not under test here either.
vi.mock('@/hooks/useConversations', () => ({
  useConversations: () => ({
    conversations: [],
    totalUnread: 0,
    loading: false,
    refresh: vi.fn(),
    startConversation: vi.fn(),
  }),
}))

const AUTH_USER = {
  user: { id: 'u1', email: 'jane@vitstudent.ac.in' },
  profile: { id: 'u1', name: 'Jane Doe', email: 'jane@vitstudent.ac.in', phone: '9876543210' },
  emailVerified: true,
}

// Mirrors App.tsx's real route tree: one auth guard + one shell wrapping
// every protected route, exercised here with lightweight placeholder
// pages instead of the real (lazy, data-fetching) ones.
function renderShellApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<div>Login Page</div>} />
        <Route
          element={
            <ProtectedRoute>
              <AppShell />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<div>Home Page</div>} />
          <Route path="/post-request" element={<div>Post Request Page</div>} />
          <Route path="/activity/ordering" element={<div>Ordering Page</div>} />
          <Route path="/activity/delivering" element={<div>Delivering Page</div>} />
          <Route path="/profile" element={<div>Profile Page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('route protection', () => {
  it('redirects to /login when unauthenticated', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false, signOut: vi.fn() })
    renderShellApp('/')
    expect(screen.getByText('Login Page')).toBeInTheDocument()
    expect(screen.queryByText('Home Page')).not.toBeInTheDocument()
  })

  it('shows neither the shell nor a redirect while auth is still resolving', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: true, signOut: vi.fn() })
    renderShellApp('/')
    expect(screen.queryByText('Login Page')).not.toBeInTheDocument()
    expect(screen.queryByText('Home Page')).not.toBeInTheDocument()
  })

  it('renders the shell and the route content once authenticated', () => {
    mockUseAuth.mockReturnValue({ user: AUTH_USER, loading: false, signOut: vi.fn() })
    renderShellApp('/profile')
    expect(screen.getByText('Profile Page')).toBeInTheDocument()
    // Wordmark appears twice - once in DesktopNav, once in MobileHeader
    // (Phase 3C) - jsdom renders both regardless of the md:hidden/hidden
    // classes real CSS would apply, so both are expected here.
    expect(screen.getAllByText('CampusLink').length).toBeGreaterThan(0)
  })
})

describe('active navigation state', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: AUTH_USER, loading: false, signOut: vi.fn() })
  })

  it('marks Profile current on /profile and leaves Home uncurrent', () => {
    renderShellApp('/profile')
    const profileLinks = screen.getAllByRole('link', { name: /^profile$/i })
    expect(profileLinks.some((el) => el.getAttribute('aria-current') === 'page')).toBe(true)

    const homeLinks = screen.getAllByRole('link', { name: /^home$/i })
    expect(homeLinks.every((el) => el.getAttribute('aria-current') !== 'page')).toBe(true)
  })

  it('marks Activity current on /activity/ordering (its default sub-view)', () => {
    renderShellApp('/activity/ordering')
    // Desktop's Activity item is now a dropdown trigger (a button), not a
    // link - the mobile bottom-tab Link is the one with a real href.
    const activityLinks = screen.getAllByRole('link', { name: /^activity$/i })
    expect(activityLinks.some((el) => el.getAttribute('aria-current') === 'page')).toBe(true)
    const activityTrigger = screen.getByRole('button', { name: /^activity$/i })
    expect(activityTrigger).toHaveAttribute('aria-current', 'page')
  })

  it('marks Activity current on /activity/delivering too, not only the default sub-view', () => {
    renderShellApp('/activity/delivering')
    const activityTrigger = screen.getByRole('button', { name: /^activity$/i })
    expect(activityTrigger).toHaveAttribute('aria-current', 'page')
  })

  it('marks Home current only on the literal root', () => {
    renderShellApp('/')
    const homeLinks = screen.getAllByRole('link', { name: /^home$/i })
    expect(homeLinks.every((el) => el.getAttribute('aria-current') === 'page')).toBe(true)
  })
})

describe('navigation targets', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: AUTH_USER, loading: false, signOut: vi.fn() })
  })

  it('Post links to /post-request on both desktop and mobile surfaces', () => {
    renderShellApp('/')
    const createLinks = screen.getAllByRole('link', { name: /^post$/i })
    expect(createLinks.length).toBeGreaterThan(0)
    createLinks.forEach((el) => expect(el.getAttribute('href')).toBe('/post-request'))
  })

  it('clicking Activity on mobile navigates directly to Ordering (no dropdown there)', async () => {
    renderShellApp('/')
    const [activityLink] = screen.getAllByRole('link', { name: /^activity$/i })
    await userEvent.click(activityLink)
    expect(await screen.findByText('Ordering Page')).toBeInTheDocument()
  })

  it('desktop Activity opens a click-triggered dropdown with exactly Ordering and Delivering', async () => {
    renderShellApp('/')
    const trigger = screen.getByRole('button', { name: /^activity$/i })
    await userEvent.click(trigger)

    const ordering = await screen.findByRole('menuitem', { name: /^ordering$/i })
    const delivering = screen.getByRole('menuitem', { name: /^delivering$/i })
    expect(ordering).toBeInTheDocument()
    expect(delivering).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem').length).toBe(2)
  })

  it('clicking Ordering in the desktop Activity dropdown navigates to the Ordering route', async () => {
    renderShellApp('/')
    await userEvent.click(screen.getByRole('button', { name: /^activity$/i }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /^ordering$/i }))
    expect(await screen.findByText('Ordering Page')).toBeInTheDocument()
  })

  it('clicking Delivering in the desktop Activity dropdown navigates to the Delivering route', async () => {
    renderShellApp('/')
    await userEvent.click(screen.getByRole('button', { name: /^activity$/i }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /^delivering$/i }))
    expect(await screen.findByText('Delivering Page')).toBeInTheDocument()
  })

  it('clicking Post navigates to the Post Request route', async () => {
    renderShellApp('/')
    const [createLink] = screen.getAllByRole('link', { name: /^post$/i })
    await userEvent.click(createLink)
    expect(await screen.findByText('Post Request Page')).toBeInTheDocument()
  })
})

describe('account menu', () => {
  it('shows the real profile name and email, and logs out through signOut', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined)
    mockUseAuth.mockReturnValue({ user: AUTH_USER, loading: false, signOut })
    renderShellApp('/')

    const trigger = screen.getByRole('button', { name: /account menu for jane doe/i })
    await userEvent.click(trigger)

    expect(await screen.findByText('Jane Doe')).toBeInTheDocument()
    expect(screen.getByText('jane@vitstudent.ac.in')).toBeInTheDocument()

    const logout = screen.getByRole('menuitem', { name: /log out/i })
    await userEvent.click(logout)

    expect(signOut).toHaveBeenCalled()
    expect(await screen.findByText('Login Page')).toBeInTheDocument()
  })

  it('falls back to the auth email when no profile name is set yet', async () => {
    mockUseAuth.mockReturnValue({
      user: { user: { id: 'u2', email: 'noprofile@vitstudent.ac.in' }, profile: null },
      loading: false,
      signOut: vi.fn(),
    })
    renderShellApp('/')

    const trigger = screen.getByRole('button', { name: /account menu for your account/i })
    await userEvent.click(trigger)
    expect(await screen.findByText('noprofile@vitstudent.ac.in')).toBeInTheDocument()
  })
})

describe('accessibility', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: AUTH_USER, loading: false, signOut: vi.fn() })
  })

  it('labels the mobile Post action for assistive tech even though it shows an icon', () => {
    renderShellApp('/')
    expect(screen.getAllByRole('link', { name: /post a request/i }).length).toBeGreaterThan(0)
  })

  it('exposes primary navigation as a labelled landmark', () => {
    renderShellApp('/')
    expect(screen.getAllByRole('navigation', { name: /primary/i }).length).toBeGreaterThan(0)
  })
})
