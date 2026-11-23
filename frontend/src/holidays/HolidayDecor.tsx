import type { CSSProperties } from 'react'
import { useLocation } from 'react-router-dom'

import { resolveHoliday, type HolidayTheme } from './holidayTheme'

/** Число частиц по темам; темы без частиц — только статичный акцент. */
const PARTICLE_COUNTS: Record<string, number> = {
  'new-year': 24,
  valentine: 12,
  defender: 10,
  'women-day': 14,
  'spring-labour': 14,
  victory: 6,
  'knowledge-day': 16,
}

/**
 * Детерминированное «случайное» распределение частиц: раскладка стабильна
 * между рендерами и не зависит от Math.random, что важно для тестов и SSR-снимков.
 */
function particleStyle(index: number, fireworks: boolean): CSSProperties {
  const left = (index * 37 + 13) % 97
  const delay = -(((index * 29 + 7) % 140) / 10)
  const duration = 9 + ((index * 17) % 70) / 10
  const size = Math.round(10 + ((index * 11) % 48) / 4)
  const style: CSSProperties = {
    left: `${left}%`,
    animationDelay: `${delay}s, ${delay / 2}s`,
    animationDuration: `${duration}s, ${Math.max(2, Math.round(duration / 3))}s`,
    fontSize: `${size}px`,
    width: `${size}px`,
    height: `${size}px`,
  }
  if (fireworks) style.top = `${18 + ((index * 23) % 42)}%`
  return style
}

function Garland() {
  return (
    <div className="holiday-garland">
      {Array.from({ length: 14 }, (_, i) => <span key={i} className="holiday-garland-bulb" />)}
    </div>
  )
}

/**
 * Слой праздничного оформления. Рендерится поверх интерфейса, не перехватывает
 * события (pointer-events: none) и скрыт от скринридеров. При inline=true
 * занимает ближайший позиционированный контейнер — для галереи предпросмотра.
 */
export function HolidayDecor({ theme, inline = false }: { theme: HolidayTheme; inline?: boolean }) {
  const count = PARTICLE_COUNTS[theme.id] ?? 0
  const fireworks = theme.id === 'victory'
  return (
    <div aria-hidden="true" className={`holiday-decor${inline ? ' holiday-decor--inline' : ''}`} data-holiday={theme.id}>
      {theme.id === 'new-year' ? <Garland /> : null}
      {theme.id === 'victory' ? <div className="holiday-ribbon" /> : null}
      {theme.id === 'russia-day' ? <div className="holiday-flagbar" /> : null}
      {theme.id === 'unity-day' ? <div className="holiday-flagcorner" /> : null}
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="holiday-particle" style={particleStyle(i, fireworks)} />
      ))}
    </div>
  )
}

/** Автоматический слой: тема из `?holiday=` или по календарю на сегодня. */
export function HolidayDecorAuto() {
  const location = useLocation()
  const theme = resolveHoliday(location.search)
  return theme ? <HolidayDecor theme={theme} /> : null
}
