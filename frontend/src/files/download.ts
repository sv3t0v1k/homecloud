import { API_BASE_URL, apiRequest } from '../api/client'
import type { FileItem } from '../types/files'

// Only tiny JSON capability preparation enters JavaScript. The file response
// belongs to the browser download manager, never Axios/Blob/object URLs.
export async function downloadOriginalFile(file: Pick<FileItem, 'id' | 'name' | 'size'>): Promise<void> {
  const size = Number(file.size)
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid file size')
  const result = await apiRequest<{ downloadPath: string }>({ method: 'POST', url: `/native-downloads/${file.id}/prepare`, withCredentials: true })
  if (result.downloadPath !== `/native-downloads/${file.id}`) throw new Error('Invalid download endpoint')
  handOffToBrowser(result.downloadPath)
}

/** Бинарный предпросмотр (PDF, аудио) не должен тянуть в память огромные файлы. */
export const MAX_BINARY_PREVIEW_BYTES = 50 * 1024 * 1024

export class BinaryPreviewTooLargeError extends Error {
  constructor() {
    super('File exceeds the binary preview limit')
    this.name = 'BinaryPreviewTooLargeError'
  }
}

/**
 * Загружает файл в память для предпросмотра PDF/аудио через тот же
 * одноразовый native-download capability, что и обычное скачивание.
 */
export async function fetchFileBlob(
  file: Pick<FileItem, 'id' | 'name' | 'size'>,
  mimeType: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const size = Number(file.size)
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid file size')
  if (size > MAX_BINARY_PREVIEW_BYTES) throw new BinaryPreviewTooLargeError()
  const result = await apiRequest<{ downloadPath: string }>({ method: 'POST', url: `/native-downloads/${file.id}/prepare`, withCredentials: true, signal })
  if (result.downloadPath !== `/native-downloads/${file.id}`) throw new Error('Invalid download endpoint')
  const response = await fetch(nativeDownloadUrl(result.downloadPath), { signal })
  if (!response.ok) throw new Error(`Binary preview download failed with status ${response.status}`)
  const buffer = await response.arrayBuffer()
  return new Blob([buffer], { type: mimeType })
}

export type ArchiveSelection = { kind: 'file' | 'folder'; id: number }

export async function downloadSelectionArchive(items: ArchiveSelection[]): Promise<void> {
  if (items.length < 2 || items.some((item) => !Number.isSafeInteger(item.id) || item.id <= 0 || !['file', 'folder'].includes(item.kind))) {
    throw new RangeError('Invalid archive selection')
  }
  const result = await apiRequest<{ downloadPath: string }>({
    method: 'POST', url: '/files/download-archives/prepare', data: { items }, withCredentials: true,
  })
  // Accept only an opaque archive capability on the expected native endpoint.
  // Do not let an unexpected server response navigate the browser elsewhere.
  if (!/^\/native-download-archives\/[a-f0-9]{32}$/.test(result.downloadPath)) throw new Error('Invalid archive download endpoint')
  handOffToBrowser(result.downloadPath)
}

function handOffToBrowser(path: string): void {
  const anchor = document.createElement('a')
  anchor.href = nativeDownloadUrl(path)
  // Attachment responses must navigate at the top level. The ingress forbids
  // framing, so an iframe can consume the one-time capability without saving.
  anchor.rel = 'noreferrer'
  anchor.style.display = 'none'
  document.body.append(anchor)
  try { anchor.click() } finally { anchor.remove() }
}

export function nativeDownloadUrl(path: string): string {
  const url = new URL(`${API_BASE_URL.replace(/\/$/, '')}${path}`, window.location.href)
  // Cookie scope and Strict SameSite require the deployed frontend/API origin.
  if (url.origin !== window.location.origin) throw new Error('Native downloads require a same-origin API')
  return url.href
}
