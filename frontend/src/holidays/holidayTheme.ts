/**
 * Календарь праздничных оформлений интерфейса.
 *
 * Тема включается за `window.daysBefore` дней до даты праздника и показывается
 * до дня окончания включительно. Окно Нового года переходит через границу года.
 * Предпросмотр: параметр `?holiday=<id>` включает тему принудительно,
 * `?holiday=off` отключает оформление независимо от даты.
 */

export interface HolidayDate { month: number; day: number }

export interface HolidayTheme {
  id: string
  title: string
  /** Дата начала показа (месяц/день, включительно). */
  start: HolidayDate
  /** Дата конца показа (месяц/день, включительно). Если раньше start — окно через границу года. */
  end: HolidayDate
  /** Короткое описание декора для галереи предпросмотра. */
  summary: string
}

export const HOLIDAY_THEMES: readonly HolidayTheme[] = [
  {
    id: 'new-year',
    title: 'Новый год',
    start: { month: 12, day: 18 },
    end: { month: 1, day: 8 },
    summary: 'Падающий снег и гирлянда в шапке',
  },
  {
    id: 'valentine',
    title: '14 февраля',
    start: { month: 2, day: 7 },
    end: { month: 2, day: 14 },
    summary: 'Всплывающие сердечки',
  },
  {
    id: 'defender',
    title: '23 февраля',
    start: { month: 2, day: 16 },
    end: { month: 2, day: 23 },
    summary: 'Мерцающие звёзды',
  },
  {
    id: 'women-day',
    title: '8 марта',
    start: { month: 3, day: 1 },
    end: { month: 3, day: 8 },
    summary: 'Лепестки тюльпанов',
  },
  {
    id: 'spring-labour',
    title: '1 мая',
    start: { month: 4, day: 24 },
    end: { month: 5, day: 1 },
    summary: 'Весенние листья',
  },
  {
    id: 'victory',
    title: '9 мая',
    start: { month: 5, day: 2 },
    end: { month: 5, day: 9 },
    summary: 'Георгиевская ленточка и салют',
  },
  {
    id: 'russia-day',
    title: 'День России',
    start: { month: 6, day: 5 },
    end: { month: 6, day: 12 },
    summary: 'Триколор-акцент в шапке',
  },
  {
    id: 'knowledge-day',
    title: '1 сентября',
    start: { month: 8, day: 25 },
    end: { month: 9, day: 1 },
    summary: 'Осенние листья',
  },
  {
    id: 'unity-day',
    title: 'День народного единства',
    start: { month: 10, day: 28 },
    end: { month: 11, day: 4 },
    summary: 'Сдержанный триколор-флажок',
  },
]

/** Сравнение «месяц/день» как порядковое число внутри года. */
function ordinal(date: HolidayDate): number {
  return date.month * 100 + date.day
}

/** Входит ли момент в окно показа темы (границы включительно). */
export function holidayActive(theme: HolidayTheme, now: Date): boolean {
  const point = ordinal({ month: now.getMonth() + 1, day: now.getDate() })
  const start = ordinal(theme.start)
  const end = ordinal(theme.end)
  if (start <= end) return point >= start && point <= end
  // Окно через границу года (Новый год: декабрь → январь).
  return point >= start || point <= end
}

/** Активная тема по календарю; null, если сегодня ничего не празднуем. */
export function activeHoliday(now: Date = new Date()): HolidayTheme | null {
  return HOLIDAY_THEMES.find((theme) => holidayActive(theme, now)) ?? null
}

export function holidayById(id: string): HolidayTheme | null {
  return HOLIDAY_THEMES.find((theme) => theme.id === id) ?? null
}

/**
 * Тема для показа с учётом переопределения через `?holiday=<id>`.
 * Приоритет: `off` → выключено; известный id → принудительно тема;
 * неизвестное значение игнорируется и действует календарь.
 */
export function resolveHoliday(search: string, now: Date = new Date()): HolidayTheme | null {
  const override = new URLSearchParams(search).get('holiday')
  if (override === 'off') return null
  if (override) {
    const forced = holidayById(override)
    if (forced) return forced
  }
  return activeHoliday(now)
}

/** Окно показа вида «18.12 – 08.01» для галереи. */
export function formatHolidayWindow(theme: HolidayTheme): string {
  const fmt = (date: HolidayDate) => `${String(date.day).padStart(2, '0')}.${String(date.month).padStart(2, '0')}`
  return `${fmt(theme.start)} – ${fmt(theme.end)}`
}
