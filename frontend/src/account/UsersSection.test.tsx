import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { apiRequest } from '../api/client'
import { ApiError } from '../api/errors'
import { formatBytes } from '../ui/formatBytes'
import type { AdminUser, AdminUserPage } from './api'
import { UsersSection } from './UsersSection'

vi.mock('../api/client', () => ({ apiRequest: vi.fn() }))

const admin: AdminUser = {
  id: 7,
  name: 'Алексей',
  email: 'alex@example.invalid',
  role: 'ADMIN',
  isActive: true,
  storageUsed: '4503599627370496',
  storageQuota: '9007199254740991',
  fileCount: 123,
  folderCount: 45,
  createdAt: '2026-01-02T12:00:00.000Z',
}

function userPage(changes: Partial<AdminUserPage> = {}): AdminUserPage {
  return { items: [admin], page: 1, pageSize: 25, total: 1, ...changes }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('UsersSection', () => {
  it('requests the server page and displays the response fields and exact string bytes', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce(userPage())

    render(<UsersSection />)

    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: '/admin/users',
      params: { page: 1, pageSize: 25, search: '' },
    }))
    expect(screen.getByText('Алексей')).toBeInTheDocument()
    expect(screen.getByText('alex@example.invalid')).toBeInTheDocument()
    expect(screen.getByText('Администратор')).toBeInTheDocument()
    expect(screen.getByText((_, element) => element?.textContent === formatBytes(admin.storageUsed))).toBeInTheDocument()
    expect(screen.getByText((_, element) => element?.textContent === formatBytes(admin.storageQuota))).toBeInTheDocument()
    expect(screen.getByText('123')).toBeInTheDocument()
    expect(screen.getByText('45')).toBeInTheDocument()
    expect(screen.getByText(new Date(admin.createdAt).toLocaleDateString('ru-RU'))).toBeInTheDocument()
  })

  it('shows loading until the request completes', async () => {
    let resolve!: (value: AdminUserPage) => void
    vi.mocked(apiRequest).mockImplementationOnce(() => new Promise((done) => { resolve = done }))

    render(<UsersSection />)

    expect(screen.getByRole('status')).toHaveTextContent('Загружаем пользователей…')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    resolve(userPage())
    expect(await screen.findByRole('table')).toBeInTheDocument()
  })

  it('shows an empty result', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce(userPage({ items: [], total: 0 }))

    render(<UsersSection />)

    expect(await screen.findByText('Пользователи не найдены.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows a safe recoverable error and retries the same request', async () => {
    vi.mocked(apiRequest)
      .mockRejectedValueOnce(new ApiError('private server detail', 'network'))
      .mockResolvedValueOnce(userPage())
    const user = userEvent.setup()

    render(<UsersSection />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить пользователей.')
    expect(screen.queryByText(/private server detail/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Повторить загрузку' }))
    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledTimes(2)
  })

  it('distinguishes forbidden from a recoverable failure', async () => {
    vi.mocked(apiRequest).mockRejectedValueOnce(new ApiError('Administrator access required', 'authorization', 403))

    render(<UsersSection />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Доступ к списку пользователей запрещён.')
    expect(screen.queryByRole('button', { name: 'Повторить загрузку' })).not.toBeInTheDocument()
  })

  it('uses server search, resets the page and preserves search across pagination', async () => {
    vi.mocked(apiRequest).mockImplementation(async (config) => {
      const params = config.params as { page: number; search: string }
      const found = params.search === 'alice'
      return userPage({
        page: params.page,
        total: 30,
        items: [{ ...admin, id: params.page, name: found ? `Найденный ${params.page}` : `Страница ${params.page}` }],
      })
    })
    const user = userEvent.setup()

    render(<UsersSection />)
    await user.click(await screen.findByRole('button', { name: 'Следующая страница' }))
    expect(await screen.findByText('Страница 2')).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Поиск пользователей' }), '  alice  ')
    await user.click(screen.getByRole('button', { name: 'Найти' }))

    expect(await screen.findByText('Найденный 1')).toBeInTheDocument()
    await waitFor(() => expect(apiRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      params: { page: 1, pageSize: 25, search: 'alice' },
    })))

    await user.click(screen.getByRole('button', { name: 'Следующая страница' }))

    expect(await screen.findByText('Найденный 2')).toBeInTheDocument()
    expect(apiRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      params: { page: 2, pageSize: 25, search: 'alice' },
    }))
  })
})
