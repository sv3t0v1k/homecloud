import { useRef, useState } from 'react'

import { safeOperationError } from './operationErrors'
import { moveFile, moveFolder } from './api'
import { useToast } from '../ui/toastContext'

/** Кастомный MIME отличает внутреннее перетаскивание от загрузки файлов из системы. */
export const ITEMS_MIME = 'application/x-homecloud-items'

// Во время dragover DataTransfer.getData недоступен, поэтому тащимые ключи
// храним в модульном состоянии — перетаскивание всегда в пределах одной страницы.
let activeDragKeys: string[] = []

export function setActiveDrag(keys: string[]) {
  activeDragKeys = keys
}

export function getActiveDrag(): string[] {
  return activeDragKeys
}

export function clearActiveDrag() {
  activeDragKeys = []
}

export function encodeDragItems(dataTransfer: DataTransfer, keys: string[]) {
  dataTransfer.setData(ITEMS_MIME, JSON.stringify({ keys }))
  dataTransfer.effectAllowed = 'move'
}

export function hasDragItems(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(ITEMS_MIME)
}

export function decodeDragItems(dataTransfer: DataTransfer): string[] {
  try {
    const payload: unknown = JSON.parse(dataTransfer.getData(ITEMS_MIME))
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { keys?: unknown }).keys)) return []
    return (payload as { keys: unknown[] }).keys.filter((key): key is string => typeof key === 'string')
  } catch {
    return []
  }
}

export interface DropTargetHandlers {
  onDragOver(event: React.DragEvent): void
  onDragLeave(event: React.DragEvent): void
  onDrop(event: React.DragEvent): void
}

/**
 * Общая логика drop-цели «папка»: подсветка, запрет сброса папки в саму себя,
 * последовательное перемещение и уведомления. Используется строками папок
 * и элементами хлебных крошек.
 */
export function useItemsDrop(onChanged: () => void) {
  const toast = useToast()
  const [dropKey, setDropKey] = useState<string | null>(null)
  const pendingRef = useRef(false)

  async function moveKeys(keys: string[], targetFolderId: number | null) {
    const targets = keys.filter((key) => key !== `folder:${targetFolderId}`)
    if (pendingRef.current || !targets.length) return
    pendingRef.current = true
    try {
      let moved = 0
      for (const key of targets) {
        const [kind, id] = key.split(':')
        const numericId = Number(id)
        if (!Number.isSafeInteger(numericId) || numericId <= 0) continue
        if (kind === 'folder') await moveFolder(numericId, targetFolderId)
        else await moveFile(numericId, targetFolderId ?? undefined)
        moved += 1
      }
      if (moved) {
        toast.notify({ kind: 'success', key: 'dnd-move', message: `Перемещено: ${moved}` })
        onChanged()
      }
    } catch (cause) {
      toast.notify({
        kind: 'error',
        key: 'dnd-move',
        message: safeOperationError(cause, 'Не удалось переместить выбранные объекты. Папку нельзя переместить внутрь самой себя.'),
      })
      onChanged()
    } finally {
      pendingRef.current = false
    }
  }

  function targetHandlers(targetKey: string, targetFolderId: number | null): DropTargetHandlers {
    return {
      onDragOver(event) {
        if (!hasDragItems(event.dataTransfer)) return
        if (getActiveDrag().includes(targetKey)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropKey(targetKey)
      },
      onDragLeave(event) {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDropKey((current) => (current === targetKey ? null : current))
      },
      onDrop(event) {
        if (!hasDragItems(event.dataTransfer)) return
        event.preventDefault()
        setDropKey(null)
        void moveKeys(decodeDragItems(event.dataTransfer), targetFolderId)
      },
    }
  }

  return { dropKey, moveKeys, targetHandlers }
}
