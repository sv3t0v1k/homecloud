import { useLocation } from 'react-router-dom'

import { resolveHoliday, type HolidayTheme } from './holidayTheme'

/** Активная праздничная тема: ?holiday=<id> принудительно, иначе календарь. */
export function useHolidayTheme(): HolidayTheme | null {
  const location = useLocation()
  return resolveHoliday(location.search)
}
