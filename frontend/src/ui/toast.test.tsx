import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from './toast'
import { useToast } from './toastContext'

function Trigger({ onNotify }: { onNotify?: (api: ReturnType<typeof useToast>) => void }) {
  const toast = useToast()
  return (
    <button
      onClick={() => onNotify ? onNotify(toast) : toast.notify({ message: 'Готово' })}
      type="button"
    >
      Показать
    </button>
  )
}

function renderWithProvider(onNotify?: (api: ReturnType<typeof useToast>) => void) {
  return render(
    <ToastProvider>
      <Trigger onNotify={onNotify} />
    </ToastProvider>,
  )
}

describe('ToastProvider', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

  it('показывает уведомление со статусом и закрывает его кнопкой', async () => {
    const user = userEvent.setup()
    renderWithProvider()
    await user.click(screen.getByRole('button', { name: 'Показать' }))
    expect(screen.getByRole('status')).toHaveTextContent('Готово')
    await user.click(screen.getByRole('button', { name: 'Скрыть уведомление' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('вызывает действие и закрывает уведомление по кнопке действия', async () => {
    const onAction = vi.fn()
    const user = userEvent.setup()
    renderWithProvider((api) => api.notify({ message: 'В корзине', actionLabel: 'Отменить', onAction }))
    await user.click(screen.getByRole('button', { name: 'Показать' }))
    await user.click(screen.getByRole('button', { name: 'Отменить' }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('заменяет уведомление с тем же key вместо дублирования', async () => {
    const user = userEvent.setup()
    let api!: ReturnType<typeof useToast>
    renderWithProvider((instance) => { api = instance; api.notify({ message: 'Первое', key: 'same' }) })
    await user.click(screen.getByRole('button', { name: 'Показать' }))
    expect(screen.getByRole('status')).toHaveTextContent('Первое')
    api.notify({ message: 'Второе', key: 'same' })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Второе'))
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('автоматически скрывает уведомление по таймеру', async () => {
    vi.useFakeTimers()
    renderWithProvider()
    act(() => { screen.getByRole('button', { name: 'Показать' }).click() })
    expect(screen.getByRole('status')).toHaveTextContent('Готово')
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('ограничивает стек четырьмя уведомлениями', async () => {
    const user = userEvent.setup()
    let api!: ReturnType<typeof useToast>
    renderWithProvider((instance) => { api = instance })
    await user.click(screen.getByRole('button', { name: 'Показать' }))
    for (let index = 0; index < 6; index += 1) api.notify({ message: `Уведомление ${index}` })
    await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(4))
    expect(screen.queryByText('Уведомление 0')).not.toBeInTheDocument()
    expect(screen.getByText('Уведомление 5')).toBeInTheDocument()
  })

  it('помечает ошибки ролью alert', async () => {
    const user = userEvent.setup()
    renderWithProvider((api) => api.notify({ message: 'Сбой', kind: 'error' }))
    await user.click(screen.getByRole('button', { name: 'Показать' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Сбой')
  })
})
