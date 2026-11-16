import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { AxiosError, AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { apiClient, sessionClient } from '../api/client'
import { SessionProvider } from '../auth/SessionContext'
import { tokenStorage } from '../auth/tokenStorage'
import type { SearchPage } from './searchTypes'

const originalApi = apiClient.defaults.adapter
const originalRefresh = sessionClient.defaults.adapter
let calls: InternalAxiosRequestConfig[]
let discoveredSessions: unknown[]
let searchResult: SearchPage
let filePresent: boolean
let searchHandler: ((config: InternalAxiosRequestConfig) => AxiosResponse) | null

beforeEach(() => {
  localStorage.clear()
  tokenStorage.clear()
  tokenStorage.set({ accessToken: 'initial', refreshToken: 'refresh-token' })
  calls = []
  discoveredSessions = []
  searchResult = { files: [], folders: [], offset: 0, limit: 20, hasMore: false }
  filePresent = true
  searchHandler = null
  sessionClient.defaults.adapter = async config => ok(config, { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' })
  apiClient.defaults.adapter = async config => {
    calls.push(config)
    if (config.url === '/users/me') return ok(config, { id: 1, name: 'Owner', email: 'owner@example.test', isActive: true, storageQuota: '10000', storageUsed: '0' })
    if (config.url === '/auth/login') return ok(config, { accessToken: 'login-access', refreshToken: 'login-refresh' })
    if (config.url === '/auth/logout') return ok(config, null)
    if (config.url === '/uploads/sessions') return ok(config, discoveredSessions)
    if (config.url === '/files/search') {
      if (searchHandler) return searchHandler(config)
      return ok(config, { ...searchResult, offset: Number(config.params?.offset ?? 0) })
    }
    if (config.url === '/files/folders/7') return ok(config, folder())
    if (config.url === '/files/folders') return ok(config, config.params?.parentId ? [] : [folder()])
    if (config.url === '/files') return ok(config, config.params?.parentId === 7 && filePresent ? [file()] : [])
    if (config.url === '/files/storage-info') return ok(config, { storageUsed: '0', storageQuota: '10000', fileCount: 0, folderCount: 1 })
    if (config.url === '/updates/access') return ok(config, { admin: false })
    throw new Error(`Unexpected request ${config.method} ${config.url}`)
  }
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  if (!HTMLElement.prototype.scrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => undefined })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
  tokenStorage.clear()
  apiClient.defaults.adapter = originalApi
  sessionClient.defaults.adapter = originalRefresh
  vi.restoreAllMocks()
})

function NavigationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return <><output data-testid="route">{location.pathname}{location.search}</output><button onClick={() => navigate(-1)}>История назад</button></>
}
function renderWorkspace(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><SessionProvider><NavigationProbe /><App /></SessionProvider></MemoryRouter>)
}

function searchCalls() {
  return calls.filter(call => call.url === '/files/search')
}

function limitFirstSearch(retryAfter = '10') {
  let rejected = false

  searchHandler = config => {
    if (!rejected) {
      rejected = true

      throw new AxiosError(
        'rate limited',
        undefined,
        config,
        undefined,
        {
          config,
          status: 429,
          statusText: 'Too Many Requests',
          headers: new AxiosHeaders({
            'Retry-After': retryAfter,
          }),
          data: {
            statusCode: 429,
            message: 'Search temporarily limited',
          },
        },
      )
    }

    return ok(config, {
      ...searchResult,
      offset: Number(config.params?.offset ?? 0),
    })
  }
}

async function beginRateLimitedSearch(retryAfter = '10') {
  limitFirstSearch(retryAfter)
  renderWorkspace('/files')

  const user = userEvent.setup()

  await screen.findByRole('heading', {
    name: 'Мои файлы',
  })

  await user.click(screen.getByRole('button', {
    name: 'Поиск во всех файлах',
  }))

  const input = await screen.findByRole('searchbox', {
    name: 'Название файла или папки',
  })

  await user.type(input, 'report{Enter}')

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Поиск временно ограничен',
  )

  expect(searchCalls()).toHaveLength(1)

  return input
}

async function advanceSearchTime(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('global search in the shared authenticated workspace', () => {

  it('automatically searches only the latest draft after Retry-After and can revisit a cached 429', async () => {
    const input = await beginRateLimitedSearch()

    vi.useFakeTimers()

    fireEvent.change(input, {
      target: { value: 'first draft' },
    })

    await advanceSearchTime(1000)

    fireEvent.change(input, {
      target: { value: 'photo' },
    })

    await advanceSearchTime(8000)

    // No request may escape the server cooldown.
    expect(searchCalls()).toHaveLength(1)

    await advanceSearchTime(2000)

    expect(searchCalls().map(call => call.params?.q)).toEqual([
      'report',
      'photo',
    ])

    expect(screen.getByRole('heading', {
      name: 'Результаты для «photo»',
    })).toBeInTheDocument()

    // The previous query still has a cached 429.
    // After cooldown it must be searchable again.
    fireEvent.change(input, {
      target: { value: 'report' },
    })

    await advanceSearchTime(600)

    expect(searchCalls().map(call => call.params?.q)).toEqual([
      'report',
      'photo',
      'report',
    ])

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('resumes a new search after reopening Spotlight during an active cooldown', async () => {
    await beginRateLimitedSearch()

    vi.useFakeTimers()

    fireEvent.click(screen.getByRole('button', {
      name: 'Закрыть поиск',
    }))

    await advanceSearchTime(1000)

    fireEvent.click(screen.getByRole('button', {
      name: 'Поиск во всех файлах',
    }))

    const input = screen.getByRole('searchbox', {
      name: 'Название файла или папки',
    })

    fireEvent.change(input, {
      target: { value: 'photo' },
    })

    await advanceSearchTime(8000)
    expect(searchCalls()).toHaveLength(1)

    await advanceSearchTime(2000)

    expect(searchCalls().map(call => call.params?.q)).toEqual([
      'report',
      'photo',
    ])

    expect(screen.getByRole('heading', {
      name: 'Результаты для «photo»',
    })).toBeInTheDocument()
  })

  it('cancels the pending draft when Spotlight closes during cooldown', async () => {
    const input = await beginRateLimitedSearch()

    vi.useFakeTimers()

    fireEvent.change(input, {
      target: { value: 'photo' },
    })

    fireEvent.click(screen.getByRole('button', {
      name: 'Закрыть поиск',
    }))

    await advanceSearchTime(11000)

    expect(searchCalls().map(call => call.params?.q)).toEqual([
      'report',
    ])

    expect(screen.queryByRole('searchbox', {
      name: 'Название файла или папки',
    })).not.toBeInTheDocument()
  })

  it('retries the current Spotlight draft instead of the previous committed query', async () => {
    const input = await beginRateLimitedSearch('0')

    vi.useFakeTimers()

    fireEvent.change(input, {
      target: { value: 'photo' },
    })

    const retryButton = screen.getByRole('button', {
      name: 'Повторить',
    })

    expect(retryButton).toBeEnabled()

    fireEvent.click(retryButton)

    await advanceSearchTime(600)

    expect(searchCalls().map(call => call.params?.q)).toEqual([
      'report',
      'photo',
    ])

    expect(screen.getByRole('heading', {
      name: 'Результаты для «photo»',
    })).toBeInTheDocument()
  })

  it('preserves deep-search query and page through an anonymous login roundtrip', async () => {
    tokenStorage.clear()
    searchResult.files = [file()]
    renderWorkspace('/files/search?q=report&offset=40')
    const user = userEvent.setup()
    expect(await screen.findByRole('heading', { name: 'Войти' })).toBeInTheDocument()
    expect(calls.some(call => call.url === '/files/search')).toBe(false)
    await user.type(screen.getByLabelText('Электронная почта'), 'owner@example.test')
    await user.type(screen.getByLabelText('Пароль'), 'test-password')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    expect(await screen.findByRole('heading', { name: 'Результаты для «report»' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'report.txt' })).toBeInTheDocument()
    expect(screen.getByTestId('route')).toHaveTextContent('/files/search?q=report&offset=40')
    expect(calls.find(call => call.url === '/files/search')?.params).toEqual({ q: 'report', limit: 20, offset: 40 })
    expect(calls.find(call => call.url === '/auth/login')?.data).toBe(JSON.stringify({ email: 'owner@example.test', password: 'test-password' }))
  })

  it('keeps the real discovered upload queue mounted across directory → Spotlight → folder → Back', async () => {
    discoveredSessions = [{ uploadId: '00000000-0000-4000-8000-000000000001', filename: 'paused-upload.bin', totalSize: 2048, chunkSize: 1024, totalChunks: 2, uploadedSize: 1024, parentId: null, status: 'uploading', expiresAt: '2027-01-01T00:00:00Z' }]
    searchResult.folders = [folder()]
    renderWorkspace('/files')
    const user = userEvent.setup()
    const manager = await screen.findByLabelText('Загрузки')
    expect(within(manager).getByText('paused-upload.bin')).toBeInTheDocument()
    await user.click(within(manager).getByRole('button', { name: /Загрузки.*Свернуть/ }))
    const collapsed = within(manager).getByRole('button', { name: /Загрузки.*Развернуть/ })
    expect(collapsed).toHaveAttribute('aria-expanded', 'false')
    await user.click(screen.getByRole('button', { name: 'Поиск во всех файлах' }))
    const input = await screen.findByRole('searchbox', { name: 'Название файла или папки' })
    expect(screen.getByLabelText('Загрузки')).toBe(manager)
    expect(collapsed).toHaveAttribute('aria-expanded', 'false')
    await user.type(input, 'report{Enter}')

    const spotlight = screen.getByRole('region', {
      name: 'Поиск во всём облаке',
    })

    // Spotlight must not replace the current directory.
    expect(screen.getByTestId('route')).toHaveTextContent(/^\/files$/)
    expect(
      within(screen.getByRole('main')).getByRole('button', {
        name: 'report-folder',
      }),
    ).toBeInTheDocument()

    await user.click(
      await within(spotlight).findByRole('button', {
        name: 'report-folder',
      }),
    )
    expect(await screen.findByRole('heading', { name: 'report-folder' })).toBeInTheDocument()
    expect(screen.getByLabelText('Загрузки')).toBe(manager)
    expect(collapsed).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('route')).toHaveTextContent(/^\/files\/folders\/7$/)
    expect(screen.queryByRole('region', {
      name: 'Поиск во всём облаке',
    })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'История назад' }))

    expect(await screen.findByRole('heading', {
      name: 'Мои файлы',
    })).toBeInTheDocument()
    expect(screen.getByTestId('route')).toHaveTextContent(/^\/files$/)
    expect(screen.queryByRole('region', {
      name: 'Поиск во всём облаке',
    })).not.toBeInTheDocument()

    // Reopening Spotlight reuses the existing search session.
    await user.click(screen.getByRole('button', {
      name: 'Поиск во всех файлах',
    }))
    const reopened = await screen.findByRole('searchbox', {
      name: 'Название файла или папки',
    })
    expect(reopened).toHaveValue('report')

    expect(await within(screen.getByRole('region', {
      name: 'Поиск во всём облаке',
    })).findByRole('button', {
      name: 'report-folder',
    })).toBeInTheDocument()

    expect(calls.filter(call => call.url === '/files/search')).toHaveLength(1)

    await user.keyboard('{Escape}')
    expect(screen.getByLabelText('Загрузки')).toBe(manager)
    expect(collapsed).toHaveAttribute('aria-expanded', 'false')
    expect(calls.filter(call => call.url === '/uploads/sessions')).toHaveLength(1)
    expect(calls.some(call => call.method === 'delete' || call.url?.includes('/chunks'))).toBe(false)
    await user.click(collapsed)
    expect(within(manager).getByText('paused-upload.bin')).toBeVisible()
    expect(within(manager).getByText('Для докачки выберите исходный файл')).toBeVisible()
  })

  it('restores the Spotlight query, page, scroll and result after opening a folder and going Back', async () => {
    searchHandler = config => {
      const offset = Number(config.params?.offset ?? 0)

      return ok(config, {
        files: offset === 0 ? [file()] : [],
        folders: offset === 20 ? [folder()] : [],
        offset,
        limit: 20,
        hasMore: offset === 0,
      })
    }

    renderWorkspace('/files')

    const user = userEvent.setup()

    await screen.findByRole('heading', {
      name: 'Мои файлы',
    })

    await user.click(screen.getByRole('button', {
      name: 'Поиск во всех файлах',
    }))

    const input = screen.getByRole('searchbox', {
      name: 'Название файла или папки',
    })

    await user.type(input, 'report{Enter}')

    const spotlight = screen.getByRole('region', {
      name: 'Поиск во всём облаке',
    })

    await within(spotlight).findByRole('button', {
      name: 'report.txt',
    })

    await user.click(within(spotlight).getByRole('button', {
      name: 'Дальше',
    }))

    const result = await within(spotlight).findByRole(
      'button',
      { name: 'report-folder' },
    )

    expect(searchCalls().map(call => call.params?.offset)).toEqual([
      0,
      20,
    ])

    expect(within(spotlight).getByText('21–21')).toBeInTheDocument()

    spotlight.scrollTop = 137
    fireEvent.scroll(spotlight)

    await user.click(result)

    expect(await screen.findByRole('heading', {
      name: 'report-folder',
    })).toBeInTheDocument()

    expect(screen.queryByRole('region', {
      name: 'Поиск во всём облаке',
    })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', {
      name: 'История назад',
    }))

    await screen.findByRole('heading', {
      name: 'Мои файлы',
    })

    expect(screen.getByTestId('route').textContent).toBe('/files')

    // Back does not unexpectedly open the overlay.
    expect(screen.queryByRole('region', {
      name: 'Поиск во всём облаке',
    })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', {
      name: 'Поиск во всех файлах',
    }))

    const restored = screen.getByRole('region', {
      name: 'Поиск во всём облаке',
    })

    expect(within(restored).getByRole('searchbox')).toHaveValue('report')

    const restoredResult = await within(restored).findByRole(
      'button',
      { name: 'report-folder' },
    )

    expect(within(restored).getByText('21–21')).toBeInTheDocument()

    await waitFor(() => {
      expect(restoredResult).toHaveFocus()
      expect(restored.scrollTop).toBe(137)
    })

    // The existing session cache supplies the restored page.
    expect(searchCalls()).toHaveLength(2)

    // Explicit close and reopen keep the same saved context.
    await user.click(within(restored).getByRole('button', {
      name: 'Закрыть поиск',
    }))

    await user.click(screen.getByRole('button', {
      name: 'Поиск во всех файлах',
    }))

    expect(screen.getByRole('searchbox')).toHaveValue('report')
    expect(searchCalls()).toHaveLength(2)
  })

  it('does not retain Spotlight context across logout and a new login of the same owner', async () => {
    searchResult.folders = [folder()]

    renderWorkspace('/files')

    const user = userEvent.setup()

    await screen.findByRole('heading', {
      name: 'Мои файлы',
    })

    await user.click(screen.getByRole('button', {
      name: 'Поиск во всех файлах',
    }))

    await user.type(
      screen.getByRole('searchbox'),
      'private-report{Enter}',
    )

    await screen.findByRole('heading', {
      name: 'Результаты для «private-report»',
    })

    expect(searchCalls()).toHaveLength(1)

    await user.click(screen.getByRole('button', {
      name: 'Закрыть поиск',
    }))

    await user.click(screen.getByRole('button', {
      name: 'Выйти',
    }))

    await screen.findByRole('heading', {
      name: 'Войти',
    })

    expect(tokenStorage.getAccessToken()).toBeNull()

    await user.type(
      screen.getByLabelText('Электронная почта'),
      'owner@example.test',
    )

    await user.type(
      screen.getByLabelText('Пароль'),
      'test-password',
    )

    await user.click(screen.getByRole('button', {
      name: 'Войти',
    }))

    await screen.findByRole('heading', {
      name: 'Мои файлы',
    })

    await user.click(screen.getByRole('button', {
      name: 'Поиск во всех файлах',
    }))

    expect(screen.getByRole('searchbox')).toHaveValue('')

    expect(screen.queryByRole('heading', {
      name: 'Результаты для «private-report»',
    })).not.toBeInTheDocument()

    expect(searchCalls()).toHaveLength(1)

    expect(JSON.stringify(localStorage)).not.toContain('private-report')
    expect(JSON.stringify(sessionStorage)).not.toContain('private-report')
  })

  it('opens Spotlight with Ctrl+K without navigation and leaves input and modal shortcuts alone', async () => {
    renderWorkspace('/files/folders/7')
    const user = userEvent.setup()

    await screen.findByRole('heading', { name: 'report-folder' })

    const launcher = screen.getByRole('button', {
      name: 'Поиск во всех файлах',
    })

    expect(screen.queryByRole('searchbox', {
      name: 'Поиск в текущей папке',
    })).not.toBeInTheDocument()

    // A modal has priority over the global shortcut.
    await user.click(screen.getByRole('button', {
      name: 'Открыть аккаунт: Owner',
    }))

    const dialog = await screen.findByRole('dialog', {
      name: 'Аккаунт и хранилище',
    })

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })

    expect(dialog).toBeInTheDocument()
    expect(launcher).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('searchbox', {
      name: 'Название файла или папки',
    })).not.toBeInTheDocument()
    expect(screen.getByTestId('route')).toHaveTextContent(/^\/files\/folders\/7$/)

    await user.keyboard('{Escape}')

    // Opening search must leave the directory in place.
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })

    const global = await screen.findByRole('searchbox', {
      name: 'Название файла или папки',
    })

    expect(global).toHaveFocus()
    expect(launcher).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('route')).toHaveTextContent(/^\/files\/folders\/7$/)

    expect(screen.getByRole('heading', {
      name: 'report-folder',
    })).toBeInTheDocument()

    // Do not intercept the shortcut inside an editable field.
    await user.type(global, 'x')
    fireEvent.keyDown(global, { key: 'k', ctrlKey: true })

    expect(global).toHaveValue('x')
    expect(global).toHaveFocus()
    expect(launcher).toHaveAttribute('aria-expanded', 'true')
    expect(calls.filter(call => call.url === '/files/search')).toHaveLength(0)

    // Escape closes Spotlight and restores launcher focus.
    await user.keyboard('{Escape}')
    expect(launcher).toHaveFocus()
    expect(launcher).toHaveAttribute('aria-expanded', 'false')
    expect(global).not.toBeInTheDocument()

    // The macOS shortcut must work too.
    fireEvent.keyDown(window, { key: 'k', metaKey: true })

    expect(await screen.findByRole('searchbox', {
      name: 'Название файла или папки',
    })).toHaveFocus()

    await user.click(screen.getByRole('heading', {
      name: 'report-folder',
    }))

    expect(launcher).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('route')).toHaveTextContent(/^\/files\/folders\/7$/)
  })

  it('searches automatically after typing and opens a result with the keyboard', async () => {
    searchResult.folders = [folder()]
    renderWorkspace('/files')
    const user = userEvent.setup()

    await screen.findByRole('heading', { name: 'Мои файлы' })

    await user.click(screen.getByRole('button', {
      name: 'Поиск во всех файлах',
    }))

    const spotlight = screen.getByRole('region', {
      name: 'Поиск во всём облаке',
    })

    const input = within(spotlight).getByRole('searchbox', {
      name: 'Название файла или папки',
    })

    await user.type(input, 'r')
    expect(calls.filter(call => call.url === '/files/search')).toHaveLength(0)

    await user.type(input, 'eport')

    // No Enter: live search should submit after its debounce.
    const result = await within(spotlight).findByRole(
      'button',
      { name: 'report-folder' },
      { timeout: 2000 },
    )

    const searches = calls.filter(call => call.url === '/files/search')
    expect(searches).toHaveLength(1)
    expect(searches[0].params).toEqual({
      q: 'report',
      limit: 20,
      offset: 0,
    })

    expect(screen.getByTestId('route')).toHaveTextContent(/^\/files$/)
    expect(input).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    expect(result).toHaveFocus()

    await user.keyboard('{Enter}')

    expect(await screen.findByRole('heading', {
      name: 'report-folder',
    })).toBeInTheDocument()

    expect(screen.getByTestId('route')).toHaveTextContent(/^\/files\/folders\/7$/)

    expect(screen.queryByRole('region', {
      name: 'Поиск во всём облаке',
    })).not.toBeInTheDocument()
  })

  it.each([true, false])('shows a found file in its folder with present=%s, handling a stale result explicitly', async present => {
    filePresent = present
    searchResult.files = [file()]
    renderWorkspace('/files/search?q=report')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Действия: report.txt' }))
    await user.click(screen.getByRole('menuitem', { name: 'Показать в папке' }))
    expect(await screen.findByRole('heading', { name: 'report-folder' })).toBeInTheDocument()
    expect(screen.getByTestId('route')).toHaveTextContent('/files/folders/7')
    if (present) {
      const selected = await screen.findByRole('checkbox', { name: 'Выбрать report.txt' })
      await waitFor(() => expect(selected).toBeChecked())
      expect(selected.closest('tr')).toHaveClass('is-selected')
      expect(screen.getByRole('button', { name: 'report.txt' })).toHaveFocus()
      expect(screen.getByText('Найденный объект выделен в папке.')).toBeInTheDocument()
    } else {
      expect(screen.queryByRole('checkbox', { name: 'Выбрать report.txt' })).not.toBeInTheDocument()
      expect(screen.getByText('Расположение изменилось или объект больше недоступен. Повторите поиск.')).toBeInTheDocument()
    }
    await user.click(screen.getByRole('link', { name: 'Вернуться к результатам поиска' }))
    expect(await screen.findByRole('heading', { name: 'Результаты для «report»' })).toBeInTheDocument()
    expect(calls.filter(call => call.url === '/files/search')).toHaveLength(1)
  })
})

function file() {
  return { id: 11, name: 'report.txt', parentId: 7, size: '2048', mimeType: 'text/plain', isStarred: false, isDeleted: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }
}
function folder() {
  return { id: 7, name: 'report-folder', parentId: null, shareFileId: 1007, isDeleted: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }
}
function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { config, status: 200, statusText: 'OK', headers: new AxiosHeaders(), data: { success: true, data } }
}
