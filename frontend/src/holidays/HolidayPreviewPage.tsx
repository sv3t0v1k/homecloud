import { Icon } from '../ui/Icon'
import { HolidayDecor, HolidayLogoDecor } from './HolidayDecor'
import { formatHolidayWindow, HOLIDAY_THEMES } from './holidayTheme'

/**
 * Галерея всех праздничных оформлений с живым предпросмотром.
 * Открывается по адресу /files/preview/holidays; принудительный показ
 * конкретной темы в основном интерфейсе — параметром ?holiday=<id>.
 */
export function HolidayPreviewPage() {
  return (
    <section aria-labelledby="holiday-preview-heading" className="holiday-preview-page">
      <h2 id="holiday-preview-heading">Праздничные оформления</h2>
      <p className="holiday-preview-note">
        Оформление стилизует логотип под праздник; на Новый год добавляется снег.
        Тема включается автоматически за неделю до праздника (Новый год — за две) и исчезает
        по его окончании. Принудительно включить тему можно параметром адреса
        «?holiday=&lt;id&gt;», отключить — «?holiday=off».
      </p>
      <ul className="holiday-preview-grid">
        {HOLIDAY_THEMES.map((theme) => (
          <li key={theme.id} className="holiday-preview-card">
            <div className="holiday-preview-stage">
              {theme.id === 'new-year' ? <HolidayDecor inline theme={theme} /> : null}
              <span className="brand-mark holiday-preview-brand">
                <Icon name="cloud" />
                <HolidayLogoDecor theme={theme} />
              </span>
            </div>
            <h3>{theme.title}</h3>
            <p>{theme.id} · {formatHolidayWindow(theme)} · {theme.summary}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
