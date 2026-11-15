import { forwardRef, type MouseEventHandler } from 'react'
import { Icon } from './Icon'

type LiquidCloseButtonProps = {
  'aria-label': string
  onClick: MouseEventHandler<HTMLButtonElement>
  disabled?: boolean
  className?: string
  title?: string
}

export const LiquidCloseButton = forwardRef<
  HTMLButtonElement,
  LiquidCloseButtonProps
>(function LiquidCloseButton(
  { 'aria-label': ariaLabel, onClick, disabled, className, title },
  ref,
) {
  return (
    <button
      aria-label={ariaLabel}
      className={`icon-button liquid-close-button${className ? ` ${className}` : ''}`}
      disabled={disabled}
      onClick={onClick}
      ref={ref}
      title={title}
      type="button"
    >
      <Icon name="close" />
      <span className="liquid-close-label" aria-hidden="true">
        Закрыть
      </span>
    </button>
  )
})
