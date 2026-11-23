import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HolidayDecor, HolidayDecorAuto } from './HolidayDecor'
import { holidayById } from './holidayTheme'

describe('HolidayDecorAuto', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Обычный будний день без праздничных окон.
    vi.setSystemTime(new Date('2026-06-20T12:00:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ничего не рендерит в обычный день', () => {
    const { container } = render(<MemoryRouter initialEntries={['/files']}><HolidayDecorAuto /></MemoryRouter>)
    expect(container.querySelector('.holiday-decor')).toBeNull()
  })

  it('включает тему по ?holiday=<id> независимо от даты', () => {
    const { container } = render(<MemoryRouter initialEntries={['/files?holiday=victory']}><HolidayDecorAuto /></MemoryRouter>)
    const decor = container.querySelector('.holiday-decor')
    expect(decor?.getAttribute('data-holiday')).toBe('victory')
    expect(decor?.getAttribute('aria-hidden')).toBe('true')
  })

  it('holiday=off выключает оформление даже в праздник', () => {
    vi.setSystemTime(new Date('2027-01-01T12:00:00'))
    const { container } = render(<MemoryRouter initialEntries={['/files?holiday=off']}><HolidayDecorAuto /></MemoryRouter>)
    expect(container.querySelector('.holiday-decor')).toBeNull()
  })
})

describe('HolidayDecor', () => {
  it('рисует статичные акценты только предусмотренных тем', () => {
    const { container, rerender } = render(<HolidayDecor theme={holidayById('new-year')!} />)
    expect(container.querySelector('.holiday-garland')).not.toBeNull()
    expect(container.querySelector('.holiday-ribbon')).toBeNull()

    rerender(<HolidayDecor theme={holidayById('victory')!} />)
    expect(container.querySelector('.holiday-ribbon')).not.toBeNull()
    expect(container.querySelector('.holiday-garland')).toBeNull()

    rerender(<HolidayDecor theme={holidayById('russia-day')!} />)
    expect(container.querySelector('.holiday-flagbar')).not.toBeNull()

    rerender(<HolidayDecor theme={holidayById('unity-day')!} />)
    expect(container.querySelector('.holiday-flagcorner')).not.toBeNull()
  })

  it('в inline-режиме добавляет модификатор для сцены галереи', () => {
    const { container } = render(<HolidayDecor inline theme={holidayById('valentine')!} />)
    expect(container.querySelector('.holiday-decor--inline')).not.toBeNull()
    expect(container.querySelectorAll('.holiday-particle').length).toBeGreaterThan(0)
  })
})
