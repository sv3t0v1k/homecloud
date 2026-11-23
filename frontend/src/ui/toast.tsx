import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { Icon } from './Icon'
import { ToastContext, type ToastItem, type ToastOptions } from './toastContext'

const DEFAULT_DURATION_MS = 6000
const ACTION_DURATION_MS = 8000
const MAX_TOASTS = 4

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, number>())
  const keys = useRef(new Map<string, number>())
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    const activeTimers = timers.current
    return () => {
      mounted.current = false
      activeTimers.forEach((timer) => window.clearTimeout(timer))
      activeTimers.clear()
    }
  }, [])

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((current) => {
      const toast = current.find((item) => item.id === id)
      if (toast?.key && keys.current.get(toast.key) === id) keys.current.delete(toast.key)
      return current.filter((item) => item.id !== id)
    })
  }, [])

  const dismissKey = useCallback((key: string) => {
    const id = keys.current.get(key)
    if (id !== undefined) dismiss(id)
  }, [dismiss])

  const notify = useCallback((options: ToastOptions): number => {
    if (options.key) dismissKey(options.key)
    const id = nextId.current
    nextId.current += 1
    if (options.key) keys.current.set(options.key, id)
    const item: ToastItem = {
      id,
      message: options.message,
      kind: options.kind ?? 'info',
      actionLabel: options.actionLabel,
      onAction: options.onAction,
      key: options.key,
    }
    setToasts((current) => [...current, item].slice(-MAX_TOASTS))
    const duration = options.durationMs ?? (options.actionLabel ? ACTION_DURATION_MS : DEFAULT_DURATION_MS)
    timers.current.set(id, window.setTimeout(() => {
      if (mounted.current) dismiss(id)
    }, duration))
    return id
  }, [dismiss, dismissKey])

  return (
    <ToastContext.Provider value={{ notify, dismiss, dismissKey }}>
      {children}
      <div className="toast-stack" aria-label="Уведомления">
        {toasts.map((toast) => (
          <div
            className="toast"
            data-kind={toast.kind}
            key={toast.id}
            role={toast.kind === 'error' ? 'alert' : 'status'}
          >
            <span className="toast-message">{toast.message}</span>
            {toast.actionLabel ? (
              <button
                className="toast-action"
                onClick={() => {
                  dismiss(toast.id)
                  toast.onAction?.()
                }}
                type="button"
              >
                {toast.actionLabel}
              </button>
            ) : null}
            <button
              aria-label="Скрыть уведомление"
              className="toast-close"
              onClick={() => dismiss(toast.id)}
              type="button"
            >
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
