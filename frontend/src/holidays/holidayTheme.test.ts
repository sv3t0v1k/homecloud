import { describe, expect, it } from 'vitest'

import {
  activeHoliday,
  formatHolidayWindow,
  HOLIDAY_THEMES,
  holidayActive,
  holidayById,
  resolveHoliday,
} from './holidayTheme'

function date(iso: string): Date {
  return new Date(`${iso}T12:00:00`)
}

const valentine = holidayById('valentine')!
const newYear = holidayById('new-year')!

describe('holidayActive', () => {
  it('держит тему внутри окна и выключает за его границами', () => {
    expect(holidayActive(valentine, date('2026-02-06'))).toBe(false)
    expect(holidayActive(valentine, date('2026-02-07'))).toBe(true)
    expect(holidayActive(valentine, date('2026-02-14'))).toBe(true)
    expect(holidayActive(valentine, date('2026-02-15'))).toBe(false)
  })

  it('поддерживает окно Нового года через границу года', () => {
    expect(holidayActive(newYear, date('2026-12-17'))).toBe(false)
    expect(holidayActive(newYear, date('2026-12-18'))).toBe(true)
    expect(holidayActive(newYear, date('2026-12-31'))).toBe(true)
    expect(holidayActive(newYear, date('2027-01-01'))).toBe(true)
    expect(holidayActive(newYear, date('2027-01-08'))).toBe(true)
    expect(holidayActive(newYear, date('2027-01-09'))).toBe(false)
  })
})

describe('activeHoliday', () => {
  it('возвращает тему в её даты и null в обычный день', () => {
    expect(activeHoliday(date('2027-01-01'))?.id).toBe('new-year')
    expect(activeHoliday(date('2026-05-09'))?.id).toBe('victory')
    expect(activeHoliday(date('2026-06-20'))).toBeNull()
  })

  it('календарь не содержит пересекающихся окон', () => {
    for (const theme of HOLIDAY_THEMES) {
      const matches = HOLIDAY_THEMES.filter((other) =>
        holidayActive(other, date(`2026-${String(theme.start.month).padStart(2, '0')}-${String(theme.start.day).padStart(2, '0')}`)))
      expect(matches.map((item) => item.id)).toEqual([theme.id])
    }
  })
})

describe('resolveHoliday', () => {
  it('принудительно включает тему по ?holiday=<id> независимо от даты', () => {
    expect(resolveHoliday('?holiday=valentine', date('2026-06-20'))?.id).toBe('valentine')
  })

  it('holiday=off отключает оформление даже в праздник', () => {
    expect(resolveHoliday('?holiday=off', date('2027-01-01'))).toBeNull()
  })

  it('неизвестный id игнорируется и действует календарь', () => {
    expect(resolveHoliday('?holiday=halloween', date('2027-01-01'))?.id).toBe('new-year')
    expect(resolveHoliday('?holiday=halloween', date('2026-06-20'))).toBeNull()
  })

  it('без параметра действует календарь', () => {
    expect(resolveHoliday('', date('2026-03-08'))?.id).toBe('women-day')
  })
})

describe('formatHolidayWindow', () => {
  it('форматирует окно показа', () => {
    expect(formatHolidayWindow(newYear)).toBe('18.12 – 08.01')
    expect(formatHolidayWindow(valentine)).toBe('07.02 – 14.02')
  })
})
