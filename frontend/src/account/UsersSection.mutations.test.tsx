import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiRequest } from '../api/client'
import { ApiError } from '../api/errors'
import type { AdminUser, AdminUserPage } from './api'
import { UsersSection } from './UsersSection'

vi.mock('../api/client', () => ({ apiRequest: vi.fn() }))

const admin: AdminUser = {
  id: 7,
  name: 'Алексей',
  email: 'alex@example.invalid',
  role: 'ADMIN',
  isActive: true,
  storageUsed: '0',
  storageQuota: '9007199254740991',
  fileCount: 0,
  folderCount: 0,
  createdAt: '2026-01-02T12:00:00.000Z',
}

const member: AdminUser = {
  ...admin,
  id: 8,
  name: 'Мария',
  email: 'maria@example.invalid',
  role: 'USER',
}

function page(items: AdminUser[] = [admin, member]): AdminUserPage {
  return { items, page: 1, pageSize: 25, total: items.length }
}

function mockRequests(mutate?: (config: unknown) => unknown) {
  vi.mocked(apiRequest).mockImplementation(async (config) => {
    if (config.method === 'GET' && config.url === '/admin/users') return page()
    if (mutate) return mutate(config) as never
    throw new Error(`Unexpected request: ${config.method} ${config.url}`)
  })
}

function mutationCalls() {
  return vi.mocked(apiRequest).mock.calls.map(([config]) => config)
    .filter((config) => config.method !== 'GET')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.mocked(apiRequest).mockReset()
})

beforeEach(() => {
  vi.mocked(apiRequest).mockReset()
})

describe('UsersSection mutations', () => {
  it('creates a user with an exact large quota and submits only once', async () => {
    let resolve!: (value: AdminUser) => void
    mockRequests((config) => {
      const request = config as { method?: string }
      if (request.method === 'POST') return new Promise<AdminUser>((done) => { resolve = done })
      return member
    })
    const user = userEvent.setup()
    render(<UsersSection />)
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Создать пользователя' }))
    await user.type(screen.getByLabelText('Имя'), ' Новый пользователь ')
    await user.type(screen.getByLabelText('Email'), ' NEW@EXAMPLE.INVALID ')
    await user.type(screen.getByLabelText('Пароль', { exact: true }), 'strong-password')
    await user.type(screen.getByLabelText('Повторите пароль'), 'strong-password')
    const quota = screen.getByRole('textbox', { name: /^Квота, байты/ })
    await user.clear(quota)
    await user.type(quota, '9007199254740991')

    const submit = screen.getByRole('button', { name: /^Создать$/ })
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(mutationCalls()).toHaveLength(1)
    expect(mutationCalls()[0]).toEqual(expect.objectContaining({
      method: 'POST',
      url: '/admin/users',
      data: {
        name: 'Новый пользователь',
        email: 'NEW@EXAMPLE.INVALID',
        password: 'strong-password',
        role: 'USER',
        storageQuota: '9007199254740991',
      },
    }))
    expect(submit).toBeDisabled()
    resolve({ ...member, name: 'Новый пользователь', email: 'new@example.invalid' })
    expect(await screen.findByText('Пользователь new@example.invalid создан.')).toBeInTheDocument()
  })

  it('rejects mismatched creation passwords and invalid quotas before transport', async () => {
    mockRequests()
    const user = userEvent.setup()
    render(<UsersSection />)
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Создать пользователя' }))
    await user.type(screen.getByLabelText('Имя'), 'Новый')
    await user.type(screen.getByLabelText('Email'), 'new@example.invalid')
    await user.type(screen.getByLabelText('Пароль', { exact: true }), 'strong-password')
    await user.type(screen.getByLabelText('Повторите пароль'), 'other-password')
    await user.click(screen.getByRole('button', { name: /^Создать$/ }))
    expect(screen.getByRole('alert')).toHaveTextContent('Пароли не совпадают.')
    expect(mutationCalls()).toHaveLength(0)

    await user.clear(screen.getByLabelText('Повторите пароль'))
    await user.type(screen.getByLabelText('Повторите пароль'), 'strong-password')
    const quota = screen.getByRole('textbox', { name: /^Квота, байты/ })
    await user.clear(quota)
    await user.type(quota, '0900')
    fireEvent.submit(screen.getByRole('button', { name: /^Создать$/ }).closest('form')!)
    expect(screen.getByRole('alert')).toHaveTextContent('Введите целую квоту')
    expect(mutationCalls()).toHaveLength(0)
  })

  it('saves profile, role and exact quota and refreshes the list', async () => {
    mockRequests((config) => {
      const request = config as { method?: string; data?: { email: string } }
      return request.method === 'PATCH' ? { ...member, ...request.data } : member
    })
    const user = userEvent.setup()
    render(<UsersSection />)
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Редактировать Мария' }))
    const quota = screen.getByRole('textbox', { name: /^Квота, байты/ })
    await user.clear(quota)
    await user.type(quota, '9007199254740990')
    await user.selectOptions(screen.getByLabelText('Роль'), 'ADMIN')
    await user.click(screen.getByRole('button', { name: 'Сохранить изменения' }))

    await waitFor(() => expect(mutationCalls()).toHaveLength(1))
    expect(mutationCalls()[0]).toEqual(expect.objectContaining({
      method: 'PATCH', url: '/admin/users/8',
      data: { name: 'Мария', email: 'maria@example.invalid', role: 'ADMIN', storageQuota: '9007199254740990' },
    }))
    expect(await screen.findByText('Данные пользователя maria@example.invalid обновлены.')).toBeInTheDocument()
    expect(vi.mocked(apiRequest).mock.calls.filter(([config]) => config.method === 'GET')).toHaveLength(2)
  })

  it('changes a password with confirmation and ends the current session after self-change', async () => {
    mockRequests(() => ({ passwordChanged: true, sessionsRevoked: true }))
    const endSession = vi.fn()
    const user = userEvent.setup()
    render(<UsersSection currentUserId={7} onCurrentUserSessionRevoked={endSession} />)
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Сменить пароль Алексей' }))
    await user.type(screen.getByLabelText('Новый пароль'), 'new-strong-password')
    await user.type(screen.getByLabelText('Повторите новый пароль'), 'new-strong-password')
    await user.click(screen.getByRole('button', { name: 'Изменить пароль пользователя' }))

    await waitFor(() => expect(mutationCalls()).toHaveLength(1))
    expect(mutationCalls()[0]).toEqual(expect.objectContaining({
      method: 'PUT', url: '/admin/users/7/password', data: { newPassword: 'new-strong-password' },
    }))
    expect(endSession).toHaveBeenCalledOnce()
    expect(await screen.findByText('Пароль изменён. Все сеансы пользователя отозваны.')).toBeInTheDocument()
  })

  it.skip('blocks and reactivates with explicit status payloads', async () => {
    let isBlocked = false
    vi.mocked(apiRequest).mockImplementation(async (config) => {
      const request = config as { method?: string; data?: { isActive: boolean }; url?: string }
      if (request.method === 'GET') return page([admin, { ...member, isActive: isBlocked }])
      if (request.method === 'PATCH' && request.url?.includes('/status')) {
        isBlocked = request.data?.isActive === false
        return { ...member, isActive: request.data?.isActive ?? true }
      }
      // Handle other requests (like password change, etc.)
      return { ...member, isActive: true }
    })
    const user = userEvent.setup()
    render(<UsersSection />)
    // Wait for the specific user's button to appear
    await screen.findByRole('button', { name: 'Заблокировать Мария' })
    await user.click(screen.getByRole('button', { name: 'Заблокировать Мария' }))
    await user.click(screen.getByRole('button', { name: 'Заблокировать пользователя' }))
    expect(await screen.findByText(/Пользователь заблокирован/)).toBeInTheDocument()
    expect(mutationCalls()[0]).toEqual(expect.objectContaining({
      method: 'PATCH', url: '/admin/users/8/status', data: { isActive: false },
    }))

    // Wait for list refresh - wait for the button label to change
    await screen.findByRole('button', { name: 'Реактивировать Мария' })
    await user.click(screen.getByRole('button', { name: 'Реактивировать Мария' }))
    await user.click(screen.getByRole('button', { name: 'Реактивировать пользователя' }))
    await waitFor(() => expect(mutationCalls()).toHaveLength(2))
    expect(mutationCalls()[1]).toEqual(expect.objectContaining({ data: { isActive: true } }))
  })

  it('reactivates a blocked account without promising to restore old access', async () => {
    const blocked = { ...member, isActive: false }
    vi.mocked(apiRequest).mockImplementation(async (config) => {
      if (config.method === 'GET') return page([admin, blocked])
      return { ...blocked, isActive: true }
    })
    const user = userEvent.setup()
    render(<UsersSection />)
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Реактивировать Мария' }))
    await user.click(screen.getByRole('button', { name: 'Реактивировать пользователя' }))

    expect(await screen.findByText(/Ранее отозванные ссылки и сеансы не восстановлены/)).toBeInTheDocument()
    expect(mutationCalls()[0]).toEqual(expect.objectContaining({
      method: 'PATCH', url: '/admin/users/8/status', data: { isActive: true },
    }))
  })

  it('requires the account email before deletion and reports the exact request', async () => {
    mockRequests(() => ({ deleted: true, cleanupPending: false }))
    const user = userEvent.setup()
    render(<UsersSection currentUserId={7} />)
    await screen.findByRole('table')
    expect(screen.getByRole('button', { name: 'Удалить Алексей' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Удалить Мария' }))
    const submit = screen.getByRole('button', { name: 'Удалить навсегда' })
    expect(submit).toBeDisabled()
    await user.type(screen.getByLabelText('Введите email пользователя для подтверждения'), 'maria@example.invalid')
    expect(submit).toBeEnabled()
    await user.click(submit)

    expect(await screen.findByText('Пользователь maria@example.invalid и связанные данные удалены.')).toBeInTheDocument()
    expect(mutationCalls()[0]).toEqual(expect.objectContaining({ method: 'DELETE', url: '/admin/users/8' }))
  })

  it('warns when the account is gone but physical cleanup remains pending', async () => {
    mockRequests(() => ({ deleted: true, cleanupPending: true }))
    const user = userEvent.setup()
    render(<UsersSection />)
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Удалить Мария' }))
    await user.type(screen.getByLabelText('Введите email пользователя для подтверждения'), 'maria@example.invalid')
    await user.click(screen.getByRole('button', { name: 'Удалить навсегда' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Аккаунт maria@example.invalid удалён, но физическая очистка части данных не завершена.')
  })

  it.each([
    ['EMAIL_ALREADY_EXISTS', 'Пользователь с таким email уже существует.'],
    ['QUOTA_BELOW_COMMITMENTS', 'Квота меньше занятого или зарезервированного места.'],
    ['LAST_ACTIVE_ADMIN', 'Нельзя заблокировать, понизить или удалить последнего активного администратора.'],
    ['USER_RECOVERY_REQUIRED', 'сначала завершите восстановление данных пользователя'],
    ['USER_STORAGE_OPERATIONS_ACTIVE', 'дождитесь завершения активных операций хранилища'],
  ])('maps %s to a safe actionable error', async (code, message) => {
    mockRequests(() => { throw new ApiError('private backend detail', 'unknown', 409, undefined, code) })
    const user = userEvent.setup()
    render(<UsersSection />)
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Редактировать Мария' }))
    await user.click(screen.getByRole('button', { name: 'Сохранить изменения' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByText(/private backend detail/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Сохранить изменения' })).toBeEnabled()
  })
})
