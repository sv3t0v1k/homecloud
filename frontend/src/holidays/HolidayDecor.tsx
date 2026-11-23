import type { CSSProperties } from 'react'

import { type HolidayTheme } from './holidayTheme'
import { useHolidayTheme } from './useHolidayTheme'

const SNOWFLAKES = 24

/**
 * Детерминированное «случайное» распределение снежинок: раскладка стабильна
 * между рендерами и не зависит от Math.random, что важно для тестов и снимков.
 */
function snowflakeStyle(index: number): CSSProperties {
  const left = (index * 37 + 13) % 97
  const delay = -(((index * 29 + 7) % 140) / 10)
  const duration = 9 + ((index * 17) % 70) / 10
  const size = Math.round(10 + ((index * 11) % 48) / 4)
  return {
    left: `${left}%`,
    animationDelay: `${delay}s, ${delay / 2}s`,
    animationDuration: `${duration}s, ${Math.max(2, Math.round(duration / 3))}s`,
    fontSize: `${size}px`,
    width: `${size}px`,
    height: `${size}px`,
  }
}

/**
 * Полноэкранный слой оформления. Только Новый год имеет полноэкранный эффект
 * (снег); остальные праздники выражены бейджем у логотипа (HolidayLogoDecor).
 * Слой не перехватывает события и скрыт от скринридеров. При inline=true
 * занимает ближайший позиционированный контейнер — для галереи предпросмотра.
 */
export function HolidayDecor({ theme, inline = false }: { theme: HolidayTheme; inline?: boolean }) {
  if (theme.id !== 'new-year') return null
  return (
    <div aria-hidden="true" className={`holiday-decor${inline ? ' holiday-decor--inline' : ''}`} data-holiday={theme.id}>
      {Array.from({ length: SNOWFLAKES }, (_, i) => (
        <span key={i} className="holiday-particle" style={snowflakeStyle(i)} />
      ))}
    </div>
  )
}

/** Автоматический полноэкранный слой по текущей теме. */
export function HolidayDecorAuto() {
  const theme = useHolidayTheme()
  return theme ? <HolidayDecor theme={theme} /> : null
}

function MiniGarland() {
  return (
    <span className="holiday-mini-garland">
      {Array.from({ length: 5 }, (_, i) => <span key={i} className="holiday-garland-bulb" />)}
    </span>
  )
}

/**
 * Праздничный бейдж у логотипа. Рендерить внутри позиционированного
 * контейнера логотипа (.brand-mark). Вид бейджа задаётся CSS по data-holiday.
 */
export function HolidayLogoDecor({ theme }: { theme: HolidayTheme }) {
  return (
    <span aria-hidden="true" className="holiday-logo-decor" data-holiday={theme.id}>
      {theme.id === 'new-year' ? <MiniGarland /> : null}
    </span>
  )
}

/** Автоматический бейдж логотипа по текущей теме. */
export function HolidayLogoDecorAuto() {
  const theme = useHolidayTheme()
  return theme ? <HolidayLogoDecor theme={theme} /> : null
}
