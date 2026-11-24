import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { LoginPage } from './LoginPage'

const session = vi.hoisted(() => ({
  status: 'authenticated',
  notice: null,
  login: vi.fn(),
}))

vi.mock('./SessionContext', () => ({ useSession: () => session }))

beforeEach(() => {
  session.status = 'authenticated'
  session.login.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function Destination() {
  const location = useLocation()
  return <output>{location.pathname}{location.search}</output>
}

describe('completed login rendering preserves the same return destination as submit', () => {
  it.each([
    ['/files/search?q=report&offset=20', '/files/search?q=report&offset=20'],
    ['/files/folders/7', '/files/folders/7'],
    ['https://outside.example', '/files'],
    ['//outside.example', '/files'],
  ])('keeps destination %s through an authenticated render', async (from, expected) => {
    render(<MemoryRouter initialEntries={[{ pathname: '/login', state: { from } }]}><Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="*" element={<Destination />} />
    </Routes></MemoryRouter>)
    expect(await screen.findByRole('status')).toHaveTextContent(expected)
  })
})


describe('Liquid welcome and login', () => {
  it('shows the welcome while checking the session and then opens the login form', () => {
    session.status = 'bootstrapping'

    const view = render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    )

    expect(screen.getByRole('status')).toHaveTextContent('HomeCloud')
    expect(screen.getByRole('status')).toHaveTextContent('Восстанавливаем сеанс')
    expect(screen.queryByLabelText('Электронная почта')).not.toBeInTheDocument()

    session.status = 'anonymous'

    view.rerender(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    )

    expect(screen.getByLabelText('Электронная почта')).toBeInTheDocument()
    expect(screen.getByLabelText('Пароль')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Войти' })).toBeEnabled()
    expect(session.login).not.toHaveBeenCalled()
  })

  it('keeps the expanded form and entered credentials after a failed login', async () => {
    session.status = 'anonymous'
    session.login.mockRejectedValue(new Error('Network unavailable'))

    const user = userEvent.setup()

    render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    )

    const email = screen.getByLabelText('Электронная почта')
    const password = screen.getByLabelText('Пароль')

    await user.type(email, 'owner@example.com')
    await user.type(password, 'example-password')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось войти. Попробуйте ещё раз.',
    )
    expect(email).toHaveValue('owner@example.com')
    expect(password).toHaveValue('example-password')
    expect(screen.getByRole('button', { name: 'Войти' })).toBeEnabled()
    expect(session.login).toHaveBeenCalledWith(
      'owner@example.com',
      'example-password',
    )
    expect(session.login).toHaveBeenCalledTimes(1)
  })
})


function renderLoginTransition() {
  return (
    <MemoryRouter
      initialEntries={[{
        pathname: '/login',
        state: { from: '/files/search?q=report&offset=20' },
      }]}
    >
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Destination />} />
      </Routes>
    </MemoryRouter>
  )
}

async function submitTransitionLogin() {
  fireEvent.change(screen.getByLabelText('Электронная почта'), {
    target: { value: 'owner@example.com' },
  })
  fireEvent.change(screen.getByLabelText('Пароль'), {
    target: { value: 'example-password' },
  })

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
  })
}

describe('Liquid successful login transition', () => {
  it('folds the panel after success and preserves the original destination', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: true,
    }))

    session.status = 'anonymous'
    session.login.mockImplementation(async () => {
      session.status = 'authenticated'
    })

    const view = render(renderLoginTransition())

    await submitTransitionLogin()

    expect(
      view.container.querySelector('[data-mode="closing"]'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Входим…' })).toBeDisabled()
    expect(screen.getByLabelText('Пароль')).toHaveValue('')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(849)
    })

    expect(
      view.container.querySelector('[data-mode="closing"]'),
    ).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1)
    })

    expect(screen.getByRole('status')).toHaveTextContent(
      '/files/search?q=report&offset=20',
    )
    expect(session.login).toHaveBeenCalledTimes(1)
  })

  it('cancels the transition if the session expires before navigation', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: true,
    }))

    session.status = 'anonymous'
    session.login.mockImplementation(async () => {
      session.status = 'authenticated'
    })

    const view = render(renderLoginTransition())

    await submitTransitionLogin()

    expect(
      view.container.querySelector('[data-mode="closing"]'),
    ).toBeInTheDocument()

    session.status = 'anonymous'
    view.rerender(renderLoginTransition())

    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(screen.getByRole('button', { name: 'Войти' })).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Пароль')).toHaveValue('')
  })

  it('navigates immediately when reduced motion is requested', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false,
    }))

    session.status = 'anonymous'
    session.login.mockImplementation(async () => {
      session.status = 'authenticated'
    })

    render(renderLoginTransition())

    await submitTransitionLogin()

    expect(screen.getByRole('status')).toHaveTextContent(
      '/files/search?q=report&offset=20',
    )
  })
})


describe('Liquid login entrance stability', () => {
  it('does not replay the entrance after focus loss and failed login', async () => {
    session.status = 'anonymous'
    session.login.mockRejectedValue(new Error('Login failed'))

    const view = render(renderLoginTransition())
    const card = view.container.querySelector('.liquid-auth-card')
    const email = screen.getByLabelText('Электронная почта')

    expect(card).toHaveAttribute('data-entered', 'false')

    fireEvent.focus(email)

    expect(card).toHaveAttribute('data-entered', 'true')

    fireEvent.blur(email)
    await submitTransitionLogin()

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(card).toHaveAttribute('data-entered', 'true')
    expect(card).toHaveAttribute('data-mode', 'form')
    expect(screen.getByRole('button', { name: 'Войти' })).toBeEnabled()

    fireEvent.focus(email)
    fireEvent.blur(email)

    expect(card).toHaveAttribute('data-entered', 'true')
    expect(view.container.querySelector('.liquid-auth-card')).toBe(card)
  })

  it('remembers completed entrance without focusing a field', () => {
    session.status = 'anonymous'

    const view = render(renderLoginTransition())
    const card = view.container.querySelector('.liquid-auth-card')
    const reveal = view.container.querySelector('.liquid-auth-reveal')

    expect(card).toHaveAttribute('data-entered', 'false')
    expect(reveal).not.toBeNull()

    fireEvent.animationEnd(reveal!)

    expect(card).toHaveAttribute('data-entered', 'true')
  })
})
