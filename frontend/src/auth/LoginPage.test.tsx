import { cleanup, render, screen } from '@testing-library/react'
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

afterEach(cleanup)

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
