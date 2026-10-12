import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeNotice, THEME_NOTICE_MESSAGE } from './ThemeNotice'

const mockUseAuth = vi.fn()
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mockUseAuth() }))

const asUser = (id: string | null) => mockUseAuth.mockReturnValue({ user: id ? { user: { id } } : null })

beforeEach(() => {
  localStorage.clear()
})

describe('ThemeNotice', () => {
  it('shows the exact first-login message once for an account', () => {
    asUser('u1')
    render(<ThemeNotice />)
    expect(screen.getByText(THEME_NOTICE_MESSAGE)).toBeInTheDocument()
    expect(THEME_NOTICE_MESSAGE).toBe(
      'CampusLink uses light mode by default. You can switch to dark mode anytime using the theme toggle.',
    )
  })

  it('is dismissible and stays dismissed across re-mounts (page loads)', async () => {
    asUser('u1')
    const { unmount } = render(<ThemeNotice />)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss theme notice' }))
    expect(screen.queryByText(THEME_NOTICE_MESSAGE)).not.toBeInTheDocument()

    unmount()
    render(<ThemeNotice />)
    expect(screen.queryByText(THEME_NOTICE_MESSAGE)).not.toBeInTheDocument()
  })

  it('is tracked per account: a different user on the same browser still sees it', async () => {
    asUser('u1')
    const { unmount } = render(<ThemeNotice />)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss theme notice' }))
    unmount()

    asUser('u2')
    render(<ThemeNotice />)
    expect(screen.getByText(THEME_NOTICE_MESSAGE)).toBeInTheDocument()
  })

  it('shows nothing when signed out', () => {
    asUser(null)
    render(<ThemeNotice />)
    expect(screen.queryByText(THEME_NOTICE_MESSAGE)).not.toBeInTheDocument()
  })
})
