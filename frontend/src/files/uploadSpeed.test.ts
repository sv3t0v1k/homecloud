import { describe, expect, it } from 'vitest'

import { formatEta, UploadSpeedTracker } from './uploadSpeed'

describe('UploadSpeedTracker', () => {
  it('returns null until two samples are recorded', () => {
    const tracker = new UploadSpeedTracker()
    expect(tracker.read(1000)).toBeNull()
    tracker.record(100, 1000)
    expect(tracker.read(1000)).toBeNull()
  })

  it('estimates speed and ETA from the window', () => {
    const tracker = new UploadSpeedTracker()
    tracker.record(0, 0)
    tracker.record(500_000, 2000)
    tracker.record(1_000_000, 4000)
    const reading = tracker.read(3_000_000)
    expect(reading?.bytesPerSecond).toBe(250_000)
    expect(reading?.etaSeconds).toBe(8)
  })

  it('resets the window when the byte counter drops (session restart)', () => {
    const tracker = new UploadSpeedTracker()
    tracker.record(800_000, 0)
    tracker.record(900_000, 1000)
    tracker.record(0, 2000)
    expect(tracker.read(3_000_000)).toBeNull()
    tracker.record(100_000, 3000)
    const reading = tracker.read(3_000_000)
    expect(reading?.bytesPerSecond).toBe(100_000)
  })

  it('prunes samples older than the sliding window', () => {
    const tracker = new UploadSpeedTracker()
    tracker.record(0, 0)
    tracker.record(10_000, 1_000)
    tracker.record(20_000, 12_000)
    tracker.record(30_000, 13_000)
    // первые два сэмпла за пределами окна 10 с — скорость по двум последним
    const reading = tracker.read(1_000_000)
    expect(reading?.bytesPerSecond).toBe(10_000)
  })

  it('returns null when no progress is made between samples', () => {
    const tracker = new UploadSpeedTracker()
    tracker.record(500, 0)
    tracker.record(500, 5000)
    expect(tracker.read(1000)).toBeNull()
  })

  it('hides ETA when only a few seconds remain', () => {
    const tracker = new UploadSpeedTracker()
    tracker.record(0, 0)
    tracker.record(900_000, 1000)
    const reading = tracker.read(1_000_000)
    expect(reading?.bytesPerSecond).toBe(900_000)
    expect(reading?.etaSeconds).toBeNull()
  })
})

describe('formatEta', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatEta(45)).toBe('≈ 45 с')
    expect(formatEta(1)).toBe('≈ 1 с')
    expect(formatEta(0.2)).toBe('≈ 1 с')
    expect(formatEta(150)).toBe('≈ 3 мин')
    expect(formatEta(3540)).toBe('≈ 59 мин')
    expect(formatEta(3600)).toBe('≈ 1 ч')
    expect(formatEta(3900)).toBe('≈ 1 ч 5 мин')
  })
})
