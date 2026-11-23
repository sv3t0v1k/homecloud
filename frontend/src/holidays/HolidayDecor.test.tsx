import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HolidayDecorAuto, HolidayLogoDecor, HolidayLogoDecorAuto } from './HolidayDecor'
import { holidayById, HOLIDAY_THEMES } from './holidayTheme'

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

  it('полноэкранный слой есть только у Нового года', () => {
    const { container, unmount } = render(<MemoryRouter initialEntries={['/files?holiday=new-year']}><HolidayDecorAuto /></MemoryRouter>)
    const decor = container.querySelector('.holiday-decor')
    expect(decor?.getAttribute('data-holiday')).toBe('new-year')
    expect(decor?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelectorAll('.holiday-particle').length).toBeGreaterThan(0)
    unmount()

    // Остальные темы не создают полноэкранного слоя — только бейдж логотипа.
    for (const theme of HOLIDAY_THEMES.filter((item) => item.id !== 'new-year')) {
      const probe = render(<MemoryRouter initialEntries={[`/files?holiday=${theme.id}`]}><HolidayDecorAuto /></MemoryRouter>)
      expect(probe.container.querySelector('.holiday-decor'), theme.id).toBeNull()
      probe.unmount()
    }
  })

  it('holiday=off выключает оформление даже в праздник', () => {
    vi.setSystemTime(new Date('2027-01-01T12:00:00'))
    const { container } = render(<MemoryRouter initialEntries={['/files?holiday=off']}><HolidayDecorAuto /></MemoryRouter>)
    expect(container.querySelector('.holiday-decor')).toBeNull()
  })
})

describe('HolidayLogoDecor', () => {
  it('рисует бейдж с маркером темы для каждого праздника', () => {
    for (const theme of HOLIDAY_THEMES) {
      const { container, unmount } = render(<HolidayLogoDecor theme={theme} />)
      const badge = container.querySelector('.holiday-logo-decor')
      expect(badge?.getAttribute('data-holiday'), theme.id).toBe(theme.id)
      expect(badge?.getAttribute('aria-hidden')).toBe('true')
      unmount()
    }
  })

  it('на Новый год обрамляет логотип гирляндой по периметру', () => {
    const { container } = render(<HolidayLogoDecor theme={holidayById('new-year')!} />)
    const frame = container.querySelector('.holiday-garland-frame')
    expect(frame).not.toBeNull()
    expect(frame?.classList.contains('holiday-garland-frame--compact')).toBe(true)
    expect(container.querySelectorAll('.holiday-garland-side').length).toBe(4)
    expect(container.querySelectorAll('.holiday-garland-bulb').length).toBeGreaterThan(0)

    const { container: other } = render(<HolidayLogoDecor theme={holidayById('valentine')!} />)
    expect(other.querySelector('.holiday-garland-frame')).toBeNull()
  })

  it('рисует инлайн-SVG для букета, ростка, ленты и кленового листа', () => {
    for (const id of ['women-day', 'spring-labour', 'victory', 'knowledge-day']) {
      const { container, unmount } = render(<HolidayLogoDecor theme={holidayById(id)!} />)
      expect(container.querySelector('.holiday-logo-decor svg'), id).not.toBeNull()
      unmount()
    }
  })
})

describe('HolidayLogoDecorAuto', () => {
  it('включает бейдж по ?holiday=<id> и молчит в обычный день', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-20T12:00:00'))
    try {
      const themed = render(<MemoryRouter initialEntries={['/files?holiday=victory']}><HolidayLogoDecorAuto /></MemoryRouter>)
      expect(themed.container.querySelector('.holiday-logo-decor')?.getAttribute('data-holiday')).toBe('victory')
      themed.unmount()

      const plain = render(<MemoryRouter initialEntries={['/files']}><HolidayLogoDecorAuto /></MemoryRouter>)
      expect(plain.container.querySelector('.holiday-logo-decor')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
