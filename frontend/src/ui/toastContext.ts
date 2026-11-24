import { createContext, useContext } from 'react'

export interface ToastOptions {
  message: string
  kind?: 'info' | 'success' | 'error'
  actionLabel?: string
  onAction?: () => void
  durationMs?: number
  /** Уведомления с одинаковым key заменяют друг друга. */
  key?: string
}

export interface ToastItem {
  id: number
  message: string
  kind: 'info' | 'success' | 'error'
  actionLabel?: string
  onAction?: () => void
  key?: string
}

export interface ToastApi {
  notify(options: ToastOptions): number
  dismiss(id: number): void
  dismissKey(key: string): void
}

export const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast должен использоваться внутри ToastProvider')
  return api
}
