/**
 * Оценка скорости загрузки и оставшегося времени по скользящему окну сэмплов.
 * Сэмпл — пара (время, подтверждённые байты). Чистый модуль без React,
 * чтобы логику можно было проверять unit-тестами.
 */

export interface UploadSpeedReading {
  bytesPerSecond: number
  /** null, если до конца осталось так мало, что оценка уже бессмысленна */
  etaSeconds: number | null
}

interface SpeedSample {
  at: number
  bytes: number
}

const WINDOW_MS = 10_000
const MIN_SAMPLES = 2
/** ETA меньше этого порога не показываем — остались считанные секунды */
const MIN_ETA_SECONDS = 5

export class UploadSpeedTracker {
  private samples: SpeedSample[] = []

  /** Фиксирует подтверждённые байты. Падение счётчика (перезапуск сессии) сбрасывает окно. */
  record(bytes: number, at: number): void {
    const last = this.samples[this.samples.length - 1]
    if (last && bytes < last.bytes) this.samples = []
    if (last && at <= last.at && bytes === last.bytes) return
    this.samples.push({ at, bytes })
    const cutoff = at - WINDOW_MS
    while (this.samples.length > MIN_SAMPLES && this.samples[0].at < cutoff) this.samples.shift()
  }

  /** Возвращает оценку или null, если данных пока недостаточно либо скорость нулевая. */
  read(totalBytes: number): UploadSpeedReading | null {
    if (this.samples.length < MIN_SAMPLES) return null
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const elapsedMs = last.at - first.at
    if (elapsedMs <= 0) return null
    const bytesPerSecond = (last.bytes - first.bytes) / (elapsedMs / 1000)
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null
    const remaining = Math.max(0, totalBytes - last.bytes)
    const etaSeconds = remaining / bytesPerSecond
    return { bytesPerSecond, etaSeconds: etaSeconds >= MIN_ETA_SECONDS ? etaSeconds : null }
  }

  reset(): void {
    this.samples = []
  }
}

/** Человекочитаемое оставшееся время: «≈ 45 с», «≈ 3 мин», «≈ 1 ч 5 мин». */
export function formatEta(seconds: number): string {
  if (seconds < 60) return `≈ ${Math.max(1, Math.round(seconds))} с`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `≈ ${minutes} мин`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `≈ ${hours} ч ${rest} мин` : `≈ ${hours} ч`
}
