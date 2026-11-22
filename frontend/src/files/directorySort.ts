import type { FileItem, FolderItem } from '../types/files'

export type SortKey = 'name' | 'type' | 'size' | 'updatedAt'
export type SortDirection = 'asc' | 'desc'

export interface DirectorySort {
  key: SortKey
  direction: SortDirection
}

export const DEFAULT_DIRECTORY_SORT: DirectorySort = { key: 'name', direction: 'asc' }

const SORT_STORAGE_KEY = 'homecloud.directorySort'

export function readSavedSort(storage: Pick<Storage, 'getItem'> | undefined): DirectorySort {
  try {
    const raw = storage?.getItem(SORT_STORAGE_KEY)
    if (!raw) return DEFAULT_DIRECTORY_SORT
    const parsed = JSON.parse(raw) as Partial<DirectorySort>
    if (
      (parsed.key === 'name' || parsed.key === 'type' || parsed.key === 'size' || parsed.key === 'updatedAt') &&
      (parsed.direction === 'asc' || parsed.direction === 'desc')
    ) {
      return { key: parsed.key, direction: parsed.direction }
    }
  } catch {
    // Повреждённое значение не должно ломать список файлов.
  }
  return DEFAULT_DIRECTORY_SORT
}

export function saveSort(sort: DirectorySort, storage: Pick<Storage, 'setItem'> | undefined): void {
  try {
    storage?.setItem(SORT_STORAGE_KEY, JSON.stringify(sort))
  } catch {
    // Приватный режим без хранилища: сортировка просто не сохраняется.
  }
}

export function toggleSort(current: DirectorySort, key: SortKey): DirectorySort {
  if (current.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
  }
  return { key, direction: 'asc' }
}

export function fileTypeLabel(mimeType: string | null | undefined): string {
  if (mimeType?.startsWith('image/')) return 'Изображение'
  if (mimeType?.startsWith('text/')) return 'Текстовый документ'
  if (mimeType === 'application/pdf') return 'Документ PDF'
  return 'Файл'
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' })
}

function compareDates(a: string, b: string): number {
  const first = Date.parse(a)
  const second = Date.parse(b)
  if (Number.isNaN(first) || Number.isNaN(second)) return 0
  return first - second
}

function toBytes(size: string | number): number {
  const value = Number(size)
  return Number.isFinite(value) ? value : 0
}

export function filterByName<T extends { name: string }>(items: T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return items
  return items.filter((item) => item.name.toLocaleLowerCase().includes(needle))
}

function directionMultiplier(direction: SortDirection): number {
  return direction === 'asc' ? 1 : -1
}

export function sortFolders(folders: FolderItem[], sort: DirectorySort): FolderItem[] {
  const sign = directionMultiplier(sort.direction)
  const sorted = [...folders]
  sorted.sort((a, b) => {
    let result = 0
    if (sort.key === 'updatedAt') result = compareDates(a.updatedAt, b.updatedAt)
    if (result === 0) result = compareNames(a.name, b.name)
    return sign * result
  })
  return sorted
}

export function sortFiles(files: FileItem[], sort: DirectorySort): FileItem[] {
  const sign = directionMultiplier(sort.direction)
  const sorted = [...files]
  sorted.sort((a, b) => {
    let result = 0
    if (sort.key === 'type') result = compareNames(fileTypeLabel(a.mimeType), fileTypeLabel(b.mimeType))
    else if (sort.key === 'size') result = toBytes(a.size) - toBytes(b.size)
    else if (sort.key === 'updatedAt') result = compareDates(a.updatedAt, b.updatedAt)
    if (result === 0) result = compareNames(a.name, b.name)
    return sign * result
  })
  return sorted
}
