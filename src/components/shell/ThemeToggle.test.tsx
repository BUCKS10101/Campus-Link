import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from 'next-themes'
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom'
import { ThemeToggle } from './ThemeToggle'

// Mirrors App.tsx's provider settings exactly.
const Providers = ({ children }: { children: React.ReactNode }) => (
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
    {children}
  </ThemeProvider>
)

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
})

describe('theme defaults', () => {
  it('renders in light mode with no stored preference, ignoring the OS setting', () => {
    render(<Providers><ThemeToggle /></Providers>)
    expect(document.documentElement).not.toHaveClass('dark')
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeInTheDocument()
  })
})

describe('ThemeToggle', () => {
  it('switches to dark immediately and back to light', async () => {
    render(<Providers><ThemeToggle /></Providers>)
    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }))
    expect(document.documentElement).toHaveClass('dark')

    await userEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }))
    expect(document.documentElement).not.toHaveClass('dark')
  })

  it('is operable from the keyboard', async () => {
    render(<Providers><ThemeToggle /></Providers>)
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(document.documentElement).toHaveClass('dark')
    await userEvent.keyboard(' ')
    expect(document.documentElement).not.toHaveClass('dark')
  })

  it('keeps the chosen theme as the user moves between routes', async () => {
    render(
      <Providers>
        <MemoryRouter initialEntries={['/a']}>
          <ThemeToggle />
          <Link to="/b">go b</Link>
          <Routes>
            <Route path="/a" element={<p>page a</p>} />
            <Route path="/b" element={<p>page b</p>} />
          </Routes>
        </MemoryRouter>
      </Providers>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }))
    await userEvent.click(screen.getByText('go b'))
    expect(screen.getByText('page b')).toBeInTheDocument()
    expect(document.documentElement).toHaveClass('dark')
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeInTheDocument()
  })
})
