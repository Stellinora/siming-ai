import { describe, expect, it } from 'vitest'
import { PoseFramePacer } from '../features/desktopPet/poses/framePacing'

describe('desktop pet frame deadline pacing', () => {
  it.each([60, 120, 144])('retains 30fps across ten seconds of jittery %sHz callbacks', rate => {
    const pacer = new PoseFramePacer()
    const frames: number[] = []
    for (let i = 0; i <= rate * 10; i++) {
      const now = 1000 + i * 1000 / rate + Math.sin(i * 1.7) * 0.3
      const delta = pacer.next(now, 1000 / 30)
      if (delta !== null) frames.push(now)
    }
    expect(frames.length).toBeGreaterThanOrEqual(300)
    expect(frames.length).toBeLessThanOrEqual(301)
    const gaps = frames.slice(1).map((now, i) => now - frames[i])
    expect(Math.max(...gaps)).toBeLessThan(1000 / 30 + 1000 / rate + 1)
    expect(Math.min(...gaps)).toBeGreaterThan(1000 / 30 - 1000 / rate - 1)
  })
  it('keeps sleeping at 20fps, but paints changes and resizes immediately', () => {
    const pacer = new PoseFramePacer()
    expect(pacer.next(1000, 50)).toBe(0)
    expect(pacer.next(1016, 50)).toBeNull()
    expect(pacer.next(1020, 50, true)).toBe(20)
    expect(pacer.next(1030, 50)).toBeNull()
    expect(pacer.next(1031, 1000 / 30)).toBe(11)
    expect(pacer.next(1040, 1000 / 30)).toBeNull()
  })
  it('does not accumulate catch-up renders after a long pause and resets on visibility change', () => {
    const pacer = new PoseFramePacer()
    pacer.next(1000, 1000 / 30)
    expect(pacer.next(10000, 1000 / 30)).toBe(9000)
    expect(pacer.next(10001, 1000 / 30)).toBeNull()
    expect(pacer.next(10002, 1000 / 30)).toBeNull()
    pacer.reset()
    expect(pacer.next(20000, 1000 / 30)).toBe(0)
    expect(pacer.next(20001, 1000 / 30)).toBeNull()
  })
  it('rejects invalid timing and never produces extra frames on slow displays', () => {
    const pacer = new PoseFramePacer()
    expect(() => pacer.next(NaN, 33)).toThrow(RangeError)
    expect(() => pacer.next(1000, 0)).toThrow(RangeError)
    expect(() => pacer.next(1000, Infinity)).toThrow(RangeError)
    expect(pacer.next(1000, 33)).toBe(0)
    expect(pacer.next(1100, 33)).toBe(100)
    expect(pacer.next(1100, 33)).toBeNull()
  })
})
