import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError, AxiosHeaders, CanceledError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiClient } from '../api/client'
import type { FileItem } from '../types/files'
import { PreviewModal } from './PreviewModal'
import { getFilePreview, previewImageBlob, previewVideoBlob } from './preview'

describe('file preview API', () => {
  beforeEach(() => {
    apiClient.defaults.adapter = undefined
  })

  it('requests the authenticated preview contract by exact file id', async () => {
    let request: InternalAxiosRequestConfig | undefined
    apiClient.defaults.adapter = async (config) => {
      request = config
      return ok(config, { type: 'text', content: 'hello', mimeType: 'text/plain' })
    }

    await expect(getFilePreview(42)).resolves.toEqual({
      type: 'text', content: 'hello', mimeType: 'text/plain',
    })
    expect(request?.method).toBe('get')
    expect(request?.url).toBe('/previews/42')
    expect(request?.skipAuth).not.toBe(true)
  })

  it('converts the backend Buffer JSON shape without changing its MIME type', async () => {
    const blob = previewImageBlob({
      type: 'image', mimeType: 'image/png', content: { type: 'Buffer', data: [1, 2, 255] },
    })

    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(3)
  })

  it('converts the backend Buffer JSON shape for video preview', async () => {
    const blob = previewVideoBlob({
      type: 'video', mimeType: 'image/png', content: { type: 'Buffer', data: [137, 80, 78, 71] },
    })

    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(4)
  })
})

describe('PreviewModal', () => {
  const createObjectURL = vi.fn((blob: Blob | MediaSource) => { void blob; return 'blob:preview' })
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    apiClient.defaults.adapter = undefined
    // Конструктор URL должен остаться рабочим: nativeDownloadUrl создаёт new URL().
    vi.stubGlobal('URL', class extends URL {
      static override createObjectURL(blob: Blob | MediaSource) { return createObjectURL(blob) }
      static override revokeObjectURL(url: string) { revokeObjectURL(url) }
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('renders text and closes through the explicit control', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, {
      type: 'text', content: 'preview body', mimeType: 'text/plain',
    })
    const onClose = vi.fn()
    render(<PreviewModal file={file(3, 'notes.txt')} onClose={onClose} />)

    expect(await screen.findByText('preview body')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть просмотр' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('moves focus inside, traps it in both directions, closes with Escape, and restores the trigger', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, {
      type: 'text', content: 'preview body', mimeType: 'text/plain',
    })
    const user = userEvent.setup()
    render(<PreviewHarness file={file(30, 'keyboard.txt')} />)

    const trigger = screen.getByRole('button', { name: 'Open preview' })
    await user.click(trigger)
    const close = screen.getByRole('button', { name: 'Закрыть просмотр' })
    expect(close).toHaveFocus()

    await user.tab()
    expect(close).toHaveFocus()
    await user.tab({ shift: true })
    expect(close).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    await user.click(trigger)

    const reopened = screen.getByRole('dialog')
    await user.click(reopened)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('restores safely when the trigger disappears while the request is still loading', async () => {
    apiClient.defaults.adapter = async () => await new Promise<AxiosResponse>(() => undefined)
    const user = userEvent.setup()
    render(<PreviewHarness file={file(31, 'slow.txt')} removeTriggerOnClose />)

    await user.click(screen.getByRole('button', { name: 'Open preview' }))
    expect(screen.getByRole('button', { name: 'Закрыть просмотр' })).toHaveFocus()
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open preview' })).not.toBeInTheDocument()
  })

  it('creates one image object URL and revokes it on close/unmount', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, {
      type: 'image', content: { type: 'Buffer', data: [137, 80, 78, 71] }, mimeType: 'image/png',
    })
    const view = render(<PreviewModal file={file(4, 'photo.png', 'image/png')} onClose={() => undefined} />)

    expect(await screen.findByRole('img', { name: 'Предпросмотр: photo.png' })).toHaveAttribute('src', 'blob:preview')
    expect(createObjectURL).toHaveBeenCalledOnce()

    const image = screen.getByRole('img', {
      name: 'Предпросмотр: photo.png',
    })

    expect(screen.getByRole('status')).toHaveTextContent(
      'Загружаем предпросмотр…',
    )
    expect(image).toHaveAttribute('data-image-pending', 'true')

    fireEvent.load(image)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(image).not.toHaveAttribute('data-image-pending')

    view.unmount()
    expect(revokeObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview')
  })

  it('creates one video object URL and renders img for video preview', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, {
      type: 'video', content: { type: 'Buffer', data: [137, 80, 78, 71] }, mimeType: 'image/png',
    })
    const view = render(<PreviewModal file={file(42, 'clip.mp4', 'video/mp4')} onClose={() => undefined} />)

    expect(await screen.findByRole('img', { name: 'Предпросмотр: clip.mp4' })).toHaveAttribute('src', 'blob:preview')
    expect(createObjectURL).toHaveBeenCalledOnce()

    view.unmount()
    expect(revokeObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview')
  })

  it('leaves the loading state when the image cannot be displayed', async () => {
    apiClient.defaults.adapter = async config => ok(config, {
      type: 'image',
      content: { type: 'Buffer', data: [1, 2, 3] },
      mimeType: 'image/png',
    })

    render(<PreviewModal
      file={file(40, 'broken.png', 'image/png')}
      onClose={() => undefined}
    />)

    const image = await screen.findByRole('img', {
      name: 'Предпросмотр: broken.png',
    })

    fireEvent.error(image)

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Не удалось отобразить изображение.',
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(image).not.toBeInTheDocument()
  })

  it('aborts an outstanding request when closed by its parent', async () => {
    let aborted = false
    apiClient.defaults.adapter = async (config) => await new Promise<AxiosResponse>((_resolve, reject) => {
      config.signal?.addEventListener?.('abort', () => {
        aborted = true
        reject(new CanceledError('cancelled', config))
      }, { once: true })
    })
    const view = render(<PreviewModal file={file(5, 'slow.txt')} onClose={() => undefined} />)
    await screen.findByText('Загружаем предпросмотр…')

    view.unmount()
    expect(aborted).toBe(true)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('cancels a stale request when switching files and shows only the current preview', async () => {
    let firstAborted = false
    let firstStarted = false
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/previews/6') {
        firstStarted = true
        return await new Promise<AxiosResponse>((_resolve, reject) => {
          config.signal?.addEventListener?.('abort', () => {
            firstAborted = true
            reject(new CanceledError('cancelled', config))
          }, { once: true })
        })
      }
      return ok(config, { type: 'text', content: 'second file', mimeType: 'text/plain' })
    }
    const view = render(<PreviewModal file={file(6, 'first.txt')} onClose={() => undefined} />)
    await waitFor(() => expect(firstStarted).toBe(true))
    view.rerender(<PreviewModal file={file(7, 'second.txt')} onClose={() => undefined} />)

    expect(await screen.findByText('second file')).toBeInTheDocument()
    expect(firstAborted).toBe(true)
    expect(screen.getByRole('heading')).toHaveTextContent('second.txt')
  })

  it('shows the backend unsupported result as an explicit bounded state', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, {
      type: 'unsupported', content: 'internal backend wording', mimeType: 'text/plain',
    })
    render(<PreviewModal file={file(8, 'archive.zip', 'application/zip')} onClose={() => undefined} />)

    expect(await screen.findByText('Предпросмотр недоступен для этого типа файлов.')).toBeInTheDocument()
    expect(screen.queryByText('internal backend wording')).not.toBeInTheDocument()
  })

  it.each([
    [400, 'Image exceeds maximum preview size', 'слишком большой для предпросмотра'],
    [404, 'File not found on storage', 'больше недоступен'],
    [403, 'Forbidden', 'У вас нет разрешения'],
    [500, 'private /srv/storage/path', 'не смог подготовить предпросмотр'],
  ])('maps HTTP %s without exposing backend details', async (status, backendMessage, expected) => {
    apiClient.defaults.adapter = async (config) => { throw failure(config, status, backendMessage) }
    render(<PreviewModal file={file(9, 'problem.png', 'image/png')} onClose={() => undefined} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(expected)
    expect(alert).not.toHaveTextContent(backendMessage)
  })

  it('uses the existing session-expiry flow for an authentication failure', async () => {
    apiClient.defaults.adapter = async (config) => { throw failure(config, 401, 'token rejected') }
    render(<PreviewModal file={file(10, 'private.txt')} onClose={() => undefined} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Сеанс завершён')
  })

  it('navigates between siblings with buttons, arrow keys and a counter', async () => {
    apiClient.defaults.adapter = async (config) => {
      const id = Number(config.url?.split('/').pop())
      return ok(config, { type: 'text', content: `file ${id} body`, mimeType: 'text/plain' })
    }
    const siblings = [file(20, 'one.txt'), file(21, 'two.txt'), file(22, 'three.txt')]
    const user = userEvent.setup()
    render(<PreviewModal file={siblings[1]} siblings={siblings} onClose={() => undefined} />)

    expect(await screen.findByText('file 21 body')).toBeInTheDocument()
    expect(screen.getByText('2 из 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Предыдущий файл' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Следующий файл' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Следующий файл' }))
    expect(await screen.findByText('file 22 body')).toBeInTheDocument()
    expect(screen.getByText('3 из 3')).toBeInTheDocument()
    expect(screen.getByRole('heading')).toHaveTextContent('three.txt')
    expect(screen.getByRole('button', { name: 'Следующий файл' })).toBeDisabled()

    await user.keyboard('{ArrowLeft}')
    expect(await screen.findByText('file 21 body')).toBeInTheDocument()
    await user.keyboard('{ArrowLeft}')
    expect(await screen.findByText('file 20 body')).toBeInTheDocument()
    expect(screen.getByText('1 из 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Предыдущий файл' })).toBeDisabled()
  })

  it('does not render navigation controls without siblings', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, {
      type: 'text', content: 'solo', mimeType: 'text/plain',
    })
    render(<PreviewModal file={file(25, 'solo.txt')} onClose={() => undefined} />)

    expect(await screen.findByText('solo')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Следующий файл' })).not.toBeInTheDocument()
    expect(screen.queryByText(/из \d+/)).not.toBeInTheDocument()
  })

  it('renders a PDF inside a frame loaded through the native download capability', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/native-downloads/30/prepare') return ok(config, { downloadPath: '/native-downloads/30' })
      throw new Error(`Unexpected request: ${config.url}`)
    }
    render(<PreviewModal file={file(30, 'doc.pdf', 'application/pdf')} onClose={() => undefined} />)

    const frame = await screen.findByTitle('Предпросмотр: doc.pdf')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame).toHaveAttribute('src', 'blob:preview')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(screen.queryByText('Предпросмотр недоступен для этого типа файлов.')).not.toBeInTheDocument()
  })

  it('renders an audio player for audio files', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })))
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/native-downloads/31/prepare') return ok(config, { downloadPath: '/native-downloads/31' })
      throw new Error(`Unexpected request: ${config.url}`)
    }
    render(<PreviewModal file={file(31, 'song.mp3', 'audio/mpeg')} onClose={() => undefined} />)

    await waitFor(() => expect(document.querySelector('audio')).toHaveAttribute('src', 'blob:preview'))
  })

  it('rejects oversized PDF files before fetching them', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    apiClient.defaults.adapter = async (config) => { throw new Error(`Unexpected request: ${config.url}`) }
    const oversized = { ...file(32, 'huge.pdf', 'application/pdf'), size: 60 * 1024 * 1024 }
    render(<PreviewModal file={oversized} onClose={() => undefined} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Файл слишком большой для предпросмотра.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('zooms an image with toolbar buttons and resets to fit', async () => {
    apiClient.defaults.adapter = async (config) => ok(config, {
      type: 'image', content: { type: 'Buffer', data: [137, 80, 78, 71] }, mimeType: 'image/png',
    })
    const user = userEvent.setup()
    render(<PreviewModal file={file(33, 'photo.png', 'image/png')} onClose={() => undefined} />)

    const image = await screen.findByRole('img', { name: 'Предпросмотр: photo.png' })
    fireEvent.load(image)

    const reset = screen.getByRole('button', { name: 'По размеру' })
    expect(reset).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Увеличить' }))
    expect(screen.getByRole('button', { name: '125%' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Уменьшить' }))
    expect(screen.getByRole('button', { name: '100%' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: '100%' }))
    expect(screen.getByRole('button', { name: 'По размеру' })).toBeDisabled()
  })
})

function PreviewHarness({ file: target, removeTriggerOnClose = false }: { file: FileItem; removeTriggerOnClose?: boolean }) {
  const [open, setOpen] = useState(false)
  const [showTrigger, setShowTrigger] = useState(true)
  return <>{showTrigger ? <button onClick={() => setOpen(true)} type="button">Open preview</button> : null}{open ? (
    <PreviewModal file={target} onClose={() => { if (removeTriggerOnClose) setShowTrigger(false); setOpen(false) }} />
  ) : null}</>
}

function file(id: number, name: string, mimeType = 'text/plain'): FileItem {
  return { id, name, mimeType, size: 1, isDeleted: false, isStarred: false, parentId: null, updatedAt: '2026-01-01T00:00:00Z' }
}

function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { config, status: 200, statusText: 'OK', headers: new AxiosHeaders(), data: { success: true, data } }
}

function failure(config: InternalAxiosRequestConfig, status: number, message: string) {
  return new AxiosError('failed', undefined, config, undefined, {
    config, status, statusText: 'Error', headers: new AxiosHeaders(), data: { statusCode: status, message },
  })
}
