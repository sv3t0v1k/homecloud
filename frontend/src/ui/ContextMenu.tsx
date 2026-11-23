import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties } from 'react'
import { Icon } from './Icon'

export interface ContextMenuItem {
  label: string
  icon: ComponentProps<typeof Icon>['name']
  disabled?: boolean
  danger?: boolean
  onSelect(): void
}

/**
 * Контекстное меню у курсора. Переиспользует внешний вид ActionMenu,
 * но позиционируется по координатам указателя с ограничением по вьюпорту.
 */
export function ContextMenu({ label, x, y, items, onClose }: {
  label: string
  x: number
  y: number
  items: ContextMenuItem[]
  onClose(): void
}) {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<CSSProperties>({
    position: 'fixed', left: x, top: y,
    maxHeight: 'calc(100dvh - 16px)', maxWidth: 'calc(100vw - 16px)',
  })

  useLayoutEffect(() => {
    const element = menu.current
    if (!element) return
    const margin = 8
    const bounds = element.getBoundingClientRect()
    const maxHeight = Math.max(0, window.innerHeight - margin * 2)
    const maxWidth = Math.max(0, window.innerWidth - margin * 2)
    const contentHeight = bounds.height + Math.max(0, element.scrollHeight - element.clientHeight)
    const height = Math.min(contentHeight, maxHeight)
    const width = Math.min(bounds.width, maxWidth)
    setPosition({
      position: 'fixed',
      left: Math.max(margin, Math.min(x, window.innerWidth - margin - width)),
      top: Math.max(margin, Math.min(y, window.innerHeight - margin - height)),
      maxHeight,
      maxWidth,
    })
  }, [x, y])

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) onClose()
    }
    function dismiss() { onClose() }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [onClose])

  return (
    <div
      aria-label={label}
      className="action-menu-popover context-menu-popover"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
        if (event.key === 'Tab') { onClose(); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[index]?.focus()
      }}
      ref={menu}
      role="menu"
      style={position}
    >
      {items.map((item) => (
        <button
          className={item.danger ? 'action-menu-item is-danger' : 'action-menu-item'}
          disabled={item.disabled}
          key={item.label}
          onClick={() => { onClose(); item.onSelect() }}
          role="menuitem"
          tabIndex={-1}
          type="button"
        >
          <Icon name={item.icon} />{item.label}
        </button>
      ))}
    </div>
  )
}
