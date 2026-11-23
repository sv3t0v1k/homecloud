import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DIRECTORY_SORT,
  fileTypeLabel,
  filterByName,
  readSavedSort,
  saveSort,
  sortFiles,
  sortFolders,
  toggleSort,
} from './directorySort'

function folder(id: number, name: string, updatedAt = '2026-01-01T00:00:00Z') {
  return { id, shareFileId: id + 1000, name, parentId: null, isDeleted: false, updatedAt }
}

function file(id: number, name: string, size: string | number = 1, mimeType = 'text/plain', updatedAt = '2026-01-01T00:00:00Z') {
  return { id, name, size, mimeType, parentId: null, isDeleted: false, isStarred: false, updatedAt }
}

describe('directorySort', () => {
  it('sorts by name with russian locale and numeric order', () => {
    const files = [file(1, 'файл10'), file(2, 'файл2'), file(3, 'Архив')]
    expect(sortFiles(files, { key: 'name', direction: 'asc' }).map((f) => f.name)).toEqual(['Архив', 'файл2', 'файл10'])
    expect(sortFiles(files, { key: 'name', direction: 'desc' })[0].name).toBe('файл10')
  })

  it('sorts files by size numerically even for string sizes', () => {
    const files = [file(1, 'big', '2048'), file(2, 'small', '10'), file(3, 'mid', 512)]
    expect(sortFiles(files, { key: 'size', direction: 'asc' }).map((f) => f.name)).toEqual(['small', 'mid', 'big'])
  })

  it('sorts by type label and falls back to name inside one type', () => {
    const files = [
      file(1, 'z.png', '1', 'image/png'),
      file(2, 'b.txt', '1', 'text/plain'),
      file(3, 'a.txt', '1', 'text/plain'),
      file(4, 'doc.pdf', '1', 'application/pdf'),
    ]
    expect(sortFiles(files, { key: 'type', direction: 'asc' }).map((f) => f.name)).toEqual(['doc.pdf', 'z.png', 'a.txt', 'b.txt'])
  })

  it('sorts by update date', () => {
    const folders = [
      folder(1, 'old', '2020-01-01T00:00:00Z'),
      folder(2, 'new', '2026-05-01T00:00:00Z'),
    ]
    expect(sortFolders(folders, { key: 'updatedAt', direction: 'desc' })[0].name).toBe('new')
    expect(sortFolders(folders, { key: 'updatedAt', direction: 'asc' })[0].name).toBe('old')
  })

  it('does not mutate the source arrays', () => {
    const files = [file(1, 'b'), file(2, 'a')]
    const folders = [folder(1, 'b'), folder(2, 'a')]
    sortFiles(files, { key: 'name', direction: 'asc' })
    sortFolders(folders, { key: 'name', direction: 'asc' })
    expect(files[0].name).toBe('b')
    expect(folders[0].name).toBe('b')
  })

  it('toggles direction on the same key and resets to asc on a new key', () => {
    const initial = DEFAULT_DIRECTORY_SORT
    const toggled = toggleSort(initial, 'name')
    expect(toggled).toEqual({ key: 'name', direction: 'desc' })
    expect(toggleSort(toggled, 'size')).toEqual({ key: 'size', direction: 'asc' })
  })

  it('filters case-insensitively and ignores surrounding spaces', () => {
    const files = [file(1, 'Отчёт за май'), file(2, 'Фото'), file(3, 'отчётность')]
    expect(filterByName(files, '  ОТЧЁТ ').map((f) => f.name)).toEqual(['Отчёт за май', 'отчётность'])
    expect(filterByName(files, '   ')).toHaveLength(3)
  })

  it('labels known mime types', () => {
    expect(fileTypeLabel('image/jpeg')).toBe('Изображение')
    expect(fileTypeLabel('text/markdown')).toBe('Текстовый документ')
    expect(fileTypeLabel('application/pdf')).toBe('Документ PDF')
    expect(fileTypeLabel('application/zip')).toBe('Файл')
    expect(fileTypeLabel(null)).toBe('Файл')
  })

  it('restores a saved sort and falls back on garbage', () => {
    const storage = new Map<string, string>()
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    }
    saveSort({ key: 'size', direction: 'desc' }, adapter)
    expect(readSavedSort(adapter)).toEqual({ key: 'size', direction: 'desc' })
    storage.set('homecloud.directorySort', '{broken')
    expect(readSavedSort(adapter)).toEqual(DEFAULT_DIRECTORY_SORT)
    storage.set('homecloud.directorySort', JSON.stringify({ key: 'bogus', direction: 'asc' }))
    expect(readSavedSort(adapter)).toEqual(DEFAULT_DIRECTORY_SORT)
    expect(readSavedSort(undefined)).toEqual(DEFAULT_DIRECTORY_SORT)
  })
})
