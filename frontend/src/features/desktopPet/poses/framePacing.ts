// Keep a deadline grid instead of restarting a 33.3ms timer after every
// paint. At 60/120/144Hz, RAF jitter otherwise turns a 30fps cap into 20fps.
export class PoseFramePacer {
  private paintedAt: number | null = null
  private dueAt = 0
  private interval = 0

  reset() { this.paintedAt = null; this.dueAt = this.interval = 0 }

  next(now: number, interval: number, force = false): number | null {
    if (!Number.isFinite(now) || !Number.isFinite(interval) || interval <= 0) {
      throw new RangeError('Invalid pose frame timing')
    }
    const first = this.paintedAt === null
    if (first || force || interval !== this.interval) {
      this.dueAt = now + interval
    } else {
      const tolerance = 0.1
      if (now + tolerance < this.dueAt) return null
      // Skip missed deadlines once; never render a burst after a long pause.
      this.dueAt += (Math.floor((now + tolerance - this.dueAt) / interval) + 1) * interval
    }
    const delta = first ? 0 : Math.max(0, now - this.paintedAt!)
    this.paintedAt = now
    this.interval = interval
    return delta
  }
}
