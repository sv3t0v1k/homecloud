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
 * (снег); остальные праздники выражены стилизацией логотипа (HolidayLogoDecor).
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

/**
 * Гирлянда-рамка из лампочек по периметру контейнера. Четыре стороны — flex-ряды,
 * поэтому лампочки распределяются равномерно при любом их числе.
 * Используется вокруг логотипа (Новый год в приложении) и вокруг карточки
 * публичной ссылки (Новый год на страницах шаринга).
 */
export function HolidayGarlandFrame({ sides = [3, 2, 3, 2], compact = false }: { sides?: [number, number, number, number]; compact?: boolean }) {
  const names = ['top', 'right', 'bottom', 'left'] as const
  return (
    <span aria-hidden="true" className={`holiday-garland-frame${compact ? ' holiday-garland-frame--compact' : ''}`}>
      {names.map((side, i) => (
        <span key={side} className={`holiday-garland-side holiday-garland-side--${side}`}>
          {Array.from({ length: sides[i] }, (_, j) => <span key={j} className="holiday-garland-bulb" />)}
        </span>
      ))}
    </span>
  )
}

/** 8 марта: букет тюльпанов. */
function BouquetArt() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <path d="M12 22 7.6 11.5 M12 22 12 10 M12 22 16.4 11.5" fill="none" stroke="#2f9e5f" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.6 3.5 C4.2 6.2 5.4 8.6 7.6 8.6 C9.8 8.6 11 6.2 10.6 3.5 L9.1 5 7.6 3.4 6.1 5 Z" fill="#ff5b8f" />
      <path d="M9.6 1.5 C9.2 4.6 10.4 7.4 12 7.4 C13.6 7.4 14.8 4.6 14.4 1.5 L13.2 3.2 12 1.6 10.8 3.2 Z" fill="#ef476f" />
      <path d="M13.4 3.5 C13 6.2 14.2 8.6 16.4 8.6 C18.6 8.6 19.8 6.2 19.4 3.5 L17.9 5 16.4 3.4 14.9 5 Z" fill="#ffd166" />
      <path d="M8.8 14.5 C10.4 13.6 13.6 13.6 15.2 14.5 L12 21 Z" fill="#9ed06a" opacity="0.85" />
    </svg>
  )
}

/** 1 мая: росток — символ начала тепла. */
function SproutArt() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <path d="M12 22 C12 17 12 13 12 9" fill="none" stroke="#2f9e5f" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M12 13 C7.5 13 4.2 10 4.2 5.5 C8.7 5.5 11.5 8.5 12 13 Z" fill="#7bd88a" />
      <path d="M12 10 C12.5 5.5 15.3 2.5 19.8 2.5 C19.8 7 16.5 10 12 10 Z" fill="#4cc97a" />
    </svg>
  )
}

/** 9 мая: георгиевская лента с характерным вырезом-«ласточкиным хвостом». */
function GeorgeRibbonArt() {
  return (
    <svg viewBox="0 0 24 24" width="25" height="28" aria-hidden="true">
      <defs>
        <pattern id="holiday-st-george-stripes" width="24" height="4.6" patternUnits="userSpaceOnUse">
          <rect width="24" height="2.3" fill="#f08c00" />
          <rect y="2.3" width="24" height="2.3" fill="#1a1a1a" />
        </pattern>
      </defs>
      <path d="M5 1.5 H19 V19 L12 14.2 L5 19 Z" fill="url(#holiday-st-george-stripes)" stroke="rgba(0,0,0,0.35)" strokeWidth="0.8" />
    </svg>
  )
}

/** 1 сентября: кленовый лист. */
function MapleLeafArt() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <path d="M12 1.5 13.8 6.2 18.5 4.2 15.9 9 21 10.2 16.4 13 18.3 18.5 13.4 15.8 12 20.5 11 15.8 5.7 18.5 7.6 13 3 10.2 8.1 9 5.5 4.2 10.2 6.2 Z" fill="#e76f51" stroke="#c44b2f" strokeWidth="0.6" />
      <path d="M12 20.5 12 23" stroke="#8c5a2b" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Праздничная стилизация логотипа. Рендерить внутри позиционированного
 * контейнера знака (.brand-mark или .holiday-mark). Вид задаётся по data-holiday;
 * сложные образы — инлайн-SVG, День России перекрашивает фон знака через :has().
 */
export function HolidayLogoDecor({ theme }: { theme: HolidayTheme }) {
  return (
    <span aria-hidden="true" className="holiday-logo-decor" data-holiday={theme.id}>
      {theme.id === 'new-year' ? <HolidayGarlandFrame compact /> : null}
      {theme.id === 'women-day' ? <BouquetArt /> : null}
      {theme.id === 'spring-labour' ? <SproutArt /> : null}
      {theme.id === 'victory' ? <GeorgeRibbonArt /> : null}
      {theme.id === 'knowledge-day' ? <MapleLeafArt /> : null}
    </span>
  )
}

/** Автоматическая стилизация логотипа по текущей теме. */
export function HolidayLogoDecorAuto() {
  const theme = useHolidayTheme()
  return theme ? <HolidayLogoDecor theme={theme} /> : null
}
