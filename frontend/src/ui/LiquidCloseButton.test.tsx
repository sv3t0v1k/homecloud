import { createRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiquidCloseButton } from './LiquidCloseButton'

describe('LiquidCloseButton', () => {
  afterEach(cleanup)

  it('preserves its accessible name, DOM structure, extra class, title and ref', async () => {
    const onClick = vi.fn()
    const ref = createRef<HTMLButtonElement>()
    const user = userEvent.setup()

    render(
      <LiquidCloseButton
        aria-label="Закрыть просмотр"
        className="upload-dismiss"
        onClick={onClick}
        title="Закрыть просмотр"
        ref={ref}
      />,
    )

    const button = screen.getByRole('button', {
      name: 'Закрыть просмотр',
    })

    expect(button).toBe(ref.current)

    expect(button).toHaveClass(
      'icon-button',
      'liquid-close-button',
      'upload-dismiss',
    )

    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveAttribute('title', 'Закрыть просмотр')
    expect(button.children).toHaveLength(2)
    expect(button.firstElementChild?.tagName.toLowerCase()).toBe('svg')

    const label = button.querySelector('.liquid-close-label')

    expect(label).toHaveAttribute('aria-hidden', 'true')
    expect(label).toHaveTextContent('Закрыть')

    button.focus()
    expect(button).toHaveFocus()

    await user.click(button)

    expect(onClick).toHaveBeenCalledOnce()
  })

  it('blocks clicks while disabled and allows them after re-enabling', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()

    const { rerender } = render(
      <LiquidCloseButton
        aria-label="Закрыть"
        disabled
        onClick={onClick}
      />,
    )

    const button = screen.getByRole('button', {
      name: 'Закрыть',
    })

    expect(button).toBeDisabled()

    await user.click(button)

    expect(onClick).not.toHaveBeenCalled()

    rerender(
      <LiquidCloseButton
        aria-label="Закрыть"
        disabled={false}
        onClick={onClick}
      />,
    )

    expect(button).toBeEnabled()

    await user.click(button)

    expect(onClick).toHaveBeenCalledOnce()
  })
})
