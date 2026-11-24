import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { apiRequest } from '../api/client'
import { UpdatesSection } from './UpdatesSection'

vi.mock('../api/client', () => ({ apiRequest: vi.fn() }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

function mockUpdateLifecycle() {
  const state = {
    manifest: 'a'.repeat(64),
    version: 'test-new',
    status: 'NO_JOB',
    phase: null as string | null,
    statusUnavailable: false,
  }

  vi.mocked(apiRequest).mockImplementation(async (config) => {
    if (config.url === '/updates/access') {
      return { admin: true }
    }

    if (config.url === '/updates') {
      return {
        channel: 'test',
        installed: {
          version: 'test-old',
          gitSha: '1'.repeat(40),
        },
        status: 'available',
        available: {
          version: state.version,
          gitSha: '2'.repeat(40),
          manifestSha256: state.manifest,
          changes: '',
          compatibility: 'exact-migrations',
        },
      }
    }

    if (config.url === '/updates/installations/current') {
      if (state.statusUnavailable) {
        throw new Error('status unavailable')
      }

      return {
        status: state.status,
        manifestSha256:
          state.status === 'NO_JOB' ? null : state.manifest,
        phase: state.phase,
        updatedAt: 'now',
      }
    }

    if (
      config.method === 'POST' &&
      config.url === '/updates/installations'
    ) {
      return {
        status: 'QUEUED',
        manifestSha256: state.manifest,
        phase: null,
        updatedAt: 'now',
      }
    }

    throw new Error('unexpected request')
  })

  return state
}

async function advancePolling(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function statusCalls() {
  return vi.mocked(apiRequest).mock.calls.filter(
    ([config]) => config.url === '/updates/installations/current',
  )
}

function installationPosts() {
  return vi.mocked(apiRequest).mock.calls.filter(
    ([config]) =>
      config.method === 'POST' &&
      config.url === '/updates/installations',
  )
}

describe('UpdatesSection', () => {
  it('continues polling while hidden without duplicate timers and stops on unmount', async () => {
    vi.useFakeTimers()
    const state = mockUpdateLifecycle()
    const onAccessChange = vi.fn()

    state.status = 'RUNNING'
    state.phase = 'VERIFY_IMAGES'

    const view = render(
      <UpdatesSection visible={false} onAccessChange={onAccessChange} />,
    )

    await advancePolling(0)

    expect(onAccessChange).toHaveBeenCalledWith(true)
    expect(statusCalls()).toHaveLength(1)
    expect(screen.queryByRole('region', {
      name: 'Обновления',
    })).not.toBeInTheDocument()

    view.rerender(
      <UpdatesSection visible onAccessChange={onAccessChange} />,
    )

    expect(screen.getByText(
      /Выполняется: Проверка образов/,
    )).toBeInTheDocument()

    view.rerender(
      <UpdatesSection visible={false} onAccessChange={onAccessChange} />,
    )

    state.phase = 'BACKUP'
    await advancePolling(3000)

    expect(statusCalls()).toHaveLength(2)
    expect(screen.queryByRole('region', {
      name: 'Обновления',
    })).not.toBeInTheDocument()

    view.rerender(
      <UpdatesSection visible onAccessChange={onAccessChange} />,
    )

    expect(screen.getByText(
      /Выполняется: Резервное копирование/,
    )).toBeInTheDocument()

    view.rerender(
      <UpdatesSection visible={false} onAccessChange={onAccessChange} />,
    )

    await advancePolling(3000)
    expect(statusCalls()).toHaveLength(3)

    const accessCalls = vi.mocked(apiRequest).mock.calls.filter(
      ([config]) => config.url === '/updates/access',
    )

    expect(accessCalls).toHaveLength(1)
    expect(onAccessChange).toHaveBeenCalledTimes(1)
    expect(installationPosts()).toHaveLength(0)

    view.unmount()
    await advancePolling(6000)

    expect(statusCalls()).toHaveLength(3)
  })

  it('requires fresh confirmation after leaving and returning to updates', async () => {
    vi.useFakeTimers()
    const state = mockUpdateLifecycle()

    const view = render(<UpdatesSection />)
    await advancePolling(0)

    fireEvent.click(screen.getByRole('button', {
      name: 'Установить test-new',
    }))

    expect(screen.getByRole('group', {
      name: 'Подтверждение установки',
    })).toBeInTheDocument()

    view.rerender(<UpdatesSection visible={false} />)
    await advancePolling(3000)

    expect(statusCalls()).toHaveLength(2)
    expect(screen.queryByRole('group', {
      name: 'Подтверждение установки',
    })).not.toBeInTheDocument()

    view.rerender(<UpdatesSection visible />)

    expect(screen.queryByRole('button', {
      name: 'Подтвердить установку',
    })).not.toBeInTheDocument()

    expect(installationPosts()).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', {
      name: 'Установить test-new',
    }))

    fireEvent.click(screen.getByRole('button', {
      name: 'Подтвердить установку',
    }))

    await advancePolling(0)

    expect(installationPosts()).toHaveLength(1)
    expect(apiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/updates/installations',
        data: { manifestSha256: state.manifest },
      }),
    )

    expect(screen.getByText(
      'Заявка передана хосту; установка начнётся автоматически.',
    )).toBeInTheDocument()
  })

  it('invalidates confirmation when the available manifest changes', async () => {
    vi.useFakeTimers()
    const state = mockUpdateLifecycle()
    const previousManifest = state.manifest

    render(<UpdatesSection />)
    await advancePolling(0)

    fireEvent.click(screen.getByRole('button', {
      name: 'Установить test-new',
    }))

    expect(screen.getByRole('button', {
      name: 'Подтвердить установку',
    })).toBeInTheDocument()

    // Keep the displayed version unchanged deliberately.
    // The manifest digest, not the version label, is the identity.
    state.manifest = 'b'.repeat(64)

    fireEvent.click(screen.getByRole('button', {
      name: 'Проверить снова',
    }))

    await advancePolling(0)

    expect(screen.queryByRole('button', {
      name: 'Подтвердить установку',
    })).not.toBeInTheDocument()

    expect(installationPosts()).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', {
      name: 'Установить test-new',
    }))

    fireEvent.click(screen.getByRole('button', {
      name: 'Подтвердить установку',
    }))

    await advancePolling(0)

    expect(installationPosts()).toHaveLength(1)
    expect(apiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/updates/installations',
        data: { manifestSha256: state.manifest },
      }),
    )

    expect(apiRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/updates/installations',
        data: { manifestSha256: previousManifest },
      }),
    )
  })

  it.each([
    'RUNNING',
    'UNKNOWN_REQUIRES_REVIEW',
    'status-error',
  ])('discards confirmation when installation becomes ineligible: %s', async (unavailable) => {
    vi.useFakeTimers()
    const state = mockUpdateLifecycle()

    render(<UpdatesSection />)
    await advancePolling(0)

    fireEvent.click(screen.getByRole('button', {
      name: 'Установить test-new',
    }))

    expect(screen.getByRole('button', {
      name: 'Подтвердить установку',
    })).toBeInTheDocument()

    state.statusUnavailable = unavailable === 'status-error'
    state.status = state.statusUnavailable ? 'NO_JOB' : unavailable

    await advancePolling(3000)

    expect(screen.queryByRole('button', {
      name: 'Подтвердить установку',
    })).not.toBeInTheDocument()

    expect(screen.queryByRole('button', {
      name: 'Установить test-new',
    })).not.toBeInTheDocument()

    expect(installationPosts()).toHaveLength(0)

    state.status = 'NO_JOB'
    state.statusUnavailable = false

    await advancePolling(3000)

    expect(screen.getByRole('button', {
      name: 'Установить test-new',
    })).toBeInTheDocument()

    expect(screen.queryByRole('button', {
      name: 'Подтвердить установку',
    })).not.toBeInTheDocument()

    expect(installationPosts()).toHaveLength(0)
    expect(statusCalls()).toHaveLength(3)
  })

  it('does not expose the section to an ordinary user', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({ admin: false })
    render(<UpdatesSection />)
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('region', { name: 'Обновления' })).not.toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledTimes(1)
  })

  it('shows installed version but does not claim an update when verification fails', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({ admin: true }).mockResolvedValueOnce({
      channel: 'test', installed: { version: 'ac1aca1', gitSha: 'ac1aca1'.padEnd(40, '0') },
      available: null, status: 'check_unavailable',
    })
    render(<UpdatesSection />)
    expect(await screen.findByText(/Проверка сейчас недоступна/)).toBeInTheDocument()
    expect(screen.getByText(/Установленная версия: ac1aca1/)).toBeInTheDocument()
    expect(screen.queryByText(/Доступна проверенная сборка/)).not.toBeInTheDocument()
  })

  it('sends only the verified TEST manifest after confirmation and shows the host result', async () => {
    const hash = 'a'.repeat(64)
    vi.mocked(apiRequest).mockImplementation(async (config) => {
      if (config.url === '/updates/access') return { admin: true }
      if (config.url === '/updates') return {
        channel: 'test', installed: { version: 'test-old', gitSha: '1'.repeat(40) },
        status: 'available', available: { version: 'test-new', gitSha: '2'.repeat(40),
          manifestSha256: hash, changes: '', compatibility: 'exact-migrations' },
      }
      if (config.url === '/updates/installations/current') return {
        status: 'NO_JOB', manifestSha256: null, phase: null, updatedAt: null,
      }
      if (config.method === 'POST') return {
        status: 'QUEUED', manifestSha256: hash, phase: null, updatedAt: null,
      }
      throw new Error('unexpected request')
    })
    render(<UpdatesSection />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Установить test-new' }))
    expect(apiRequest).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'POST' }))
    await user.click(screen.getByRole('button', { name: 'Подтвердить установку' }))
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', url: '/updates/installations', data: { manifestSha256: hash },
    })))
    expect(await screen.findByText('Заявка передана хосту; установка начнётся автоматически.')).toBeInTheDocument()
  })

  it('allows a fresh attempt only after a preparation refusal is archived', async () => {
    vi.useFakeTimers()
    const state = mockUpdateLifecycle()
    state.status = 'STOP'
    state.phase = 'PREPARATION'

    render(<UpdatesSection />)
    await advancePolling(0)

    expect(screen.getByText(
      'Подготовка остановлена до внесения изменений. После устранения причины установку можно повторить.',
    )).toBeInTheDocument()
    expect(screen.queryByRole('button', {
      name: 'Установить test-new',
    })).not.toBeInTheDocument()

    state.status = 'NO_JOB'
    state.phase = null
    await advancePolling(3000)

    expect(screen.getByRole('button', {
      name: 'Установить test-new',
    })).toBeInTheDocument()
  })

  it('does not offer installation while the host status needs review', async () => {
    vi.mocked(apiRequest).mockImplementation(async (config) => {
      if (config.url === '/updates/access') return { admin: true }
      if (config.url === '/updates') return { channel: 'test', installed: null,
        status: 'available', available: { version: 'test-new', gitSha: '2'.repeat(40),
          manifestSha256: 'a'.repeat(64), changes: '', compatibility: 'exact-migrations' } }
      return { status: 'MANUAL_RECOVERY_REQUIRED', manifestSha256: 'a'.repeat(64), phase: 'INSTALLER', updatedAt: 'now' }
    })
    render(<UpdatesSection />)
    expect(await screen.findByText(/Нужна ручная проверка/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Установить test-new/ })).not.toBeInTheDocument()
  })

  it('refreshes the installed version after the host confirms completion', async () => {
    let checks = 0
    vi.mocked(apiRequest).mockImplementation(async (config) => {
      if (config.url === '/updates/access') return { admin: true }
      if (config.url === '/updates/installations/current') return {
        status: 'INSTALLED', manifestSha256: 'a'.repeat(64), phase: 'COMPLETE', updatedAt: 'now',
      }
      if (config.url === '/updates') {
        checks += 1
        return { channel: 'test', status: 'current', available: null,
          installed: { version: checks === 1 ? 'test-old' : 'test-new',
            gitSha: (checks === 1 ? '1' : '2').repeat(40) } }
      }
      throw new Error('unexpected request')
    })
    render(<UpdatesSection />)
    expect(await screen.findByText(/Установленная версия: test-new/)).toBeInTheDocument()
    expect(checks).toBeGreaterThanOrEqual(2)
  })
})
