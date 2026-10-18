import { beginDesktopPetDrag, endDesktopPetDrag, moveDesktopPetDrag } from './nativeBridge'

interface NativeDragBridge {
  begin(screenX: number, screenY: number): Promise<boolean>
  move(screenX: number, screenY: number): Promise<boolean>
  end(): Promise<boolean>
}

type Point = readonly [number, number]

const nativeBridge: NativeDragBridge = {
  begin: beginDesktopPetDrag,
  move: moveDesktopPetDrag,
  end: endDesktopPetDrag,
}

export class NativePetDragSession {
  readonly done: Promise<boolean>
  private pending: Point | null = null
  private closing = false
  private cancelled = false
  private wake: (() => void) | null = null

  constructor(bridge: NativeDragBridge, start: Point, previous: Promise<boolean>) {
    this.done = this.run(bridge, start, previous)
  }

  move(screenX: number, screenY: number) {
    if (this.closing || !Number.isFinite(screenX) || !Number.isFinite(screenY)) return
    this.pending = [screenX, screenY]
    this.wake?.()
  }

  finish() {
    this.closing = true
    this.wake?.()
    return this.done
  }

  cancel() {
    this.cancelled = true
    this.pending = null
    return this.finish()
  }

  private async run(bridge: NativeDragBridge, start: Point, previous: Promise<boolean>) {
    // The native API owns one drag origin, not a session ID. Never let an old
    // end() race with the next begin(), even when the user re-grabs immediately.
    await previous
    if (this.cancelled || !start.every(Number.isFinite)) {
      this.closing = true
      return false
    }
    let started = false
    let failed = false
    let ended = false
    let last: Point | null = null
    try {
      started = await bridge.begin(...start)
      if (!started) return false
      while (!this.cancelled) {
        const point = this.pending
        this.pending = null
        if (point) {
          if (last && point[0] === last[0] && point[1] === last[1]) continue
          if (!await bridge.move(...point)) {
            failed = true
            break
          }
          last = point
        } else if (this.closing) {
          break
        } else {
          // At most one in-flight move plus one replaceable latest point.
          await new Promise<void>(resolve => { this.wake = resolve })
          this.wake = null
        }
      }
    } catch {
      failed = true
    } finally {
      this.closing = true
      this.pending = null
      this.wake = null
      // A rejected begin has an unknown native outcome; serialized best-effort
      // cleanup is safe here. A reported false begin did not acquire a drag.
      if (started || failed) {
        try { ended = await bridge.end() } catch { ended = false }
      }
    }
    return started && ended && !failed && !this.cancelled
  }
}

export class NativePetDragController {
  private previous: Promise<boolean> = Promise.resolve(false)
  private sessions = new Set<NativePetDragSession>()

  constructor(private readonly bridge: NativeDragBridge = nativeBridge) {}

  begin(screenX: number, screenY: number) {
    const session = new NativePetDragSession(this.bridge, [screenX, screenY], this.previous)
    this.previous = session.done
    this.sessions.add(session)
    void session.done.then(() => { this.sessions.delete(session) })
    return session
  }

  cancelAll() {
    for (const session of this.sessions) void session.cancel()
  }
}
