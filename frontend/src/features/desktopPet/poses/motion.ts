import type { Pose, PoseId } from './contract'

export interface PoseMotion {
  lean: number; nod: number; breath: number; frame: number
  headTilt: number; suspension: number
}
export const smooth = (value: number) => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}
export const stillPoseMotion = (): PoseMotion => ({ lean: 0, nod: 0, breath: 0, frame: 0, headTilt: 0, suspension: 0 })
export const MAX_HEAD_TILT = 0.04
export const MAX_SUSPENSION = 0.022
export const HELD_LIFT_PX = 4
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value))
const hold = (phase: number, arrive: number, leave: number) =>
  smooth(phase / arrive) * (1 - smooth((phase - leave) / (1 - leave)))

export function constrainPoseMotion(motion: PoseMotion) {
  motion.headTilt = clamp(motion.headTilt, MAX_HEAD_TILT)
  // Nodding and tilting share the same neck blend. Budget their combined
  // displacement so a tap during an idle gesture cannot squash the collar.
  motion.nod = clamp(motion.nod, Math.min(8, 10 - Math.abs(motion.headTilt) * 180))
}

// Cover the full bounded motion once when the silhouette changes, without
// scanning animated pixels or rebuilding the native input region each frame.
export function poseMotionPadding(pose: Pose, scale: number) {
  return Math.max(6, Math.ceil(18 * Math.abs(scale) + (pose.id === 'picked_up' ? HELD_LIFT_PX : 0)))
}

export function blinkFrame(id: PoseId, elapsed: number) {
  if (id === 'dozing' || elapsed < 0 || elapsed >= 0.25) return 0
  // Frame 4 is a narrow slit, not a half-open eye. Reuse frame 1 on the
  // return so reopening does not jump straight from that slit to wide open.
  if (id === 'standing') {
    return elapsed < 0.045 ? 1 : elapsed < 0.07 ? 4 : elapsed < 0.115 ? 2
      : elapsed < 0.14 ? 3 : elapsed < 0.185 ? 4 : 1
  }
  return elapsed < 0.06 ? 1 : elapsed < 0.15 ? 2 : elapsed < 0.24 ? 1 : 0
}

export function deformPoint([x, y]: [number, number], pose: Pose, motion: PoseMotion) {
  const upper = 1 - smooth((y - Math.min(pose.hipY - 20, 480)) / (540 - Math.min(pose.hipY - 20, 480)))
  const head = 1 - smooth((y - pose.neckY + 8) / 93)
  const angle = motion.headTilt * head, dx = x - 192, dy = y - pose.neckY
  const px = 192 + Math.cos(angle) * dx - Math.sin(angle) * dy + motion.lean * upper
  const py = pose.neckY + Math.sin(angle) * dx + Math.cos(angle) * dy + motion.nod * head + motion.breath * upper
  const pivotY = pose.visibleBounds[1] + 24, heldY = py - pivotY
  return [192 + Math.cos(motion.suspension) * (px - 192) - Math.sin(motion.suspension) * heldY,
    pivotY + Math.sin(motion.suspension) * (px - 192) + Math.cos(motion.suspension) * heldY]
}

// Input reaction is separate from the quiet idle schedule. Screen-space drag
// samples still work when the native window follows the pointer; a held-still
// pet settles monotonically instead of driving an endless sleeve/swing loop.
export class PoseReaction {
  private targetX = 0
  private targetY = 0
  private lookX = 0
  private lookY = 0
  private tapAt = -Infinity
  private tapFrom = 0
  private pointerX: number | null = null
  private pointerAt = -Infinity
  private drive = 0
  private suspension = 0
  lookAt(x: number, y: number) {
    this.targetX = Number.isFinite(x) ? clamp(x, 1) : 0
    this.targetY = Number.isFinite(y) ? clamp(y, 1) : 0
  }
  resetLook() { this.targetX = this.targetY = 0 }
  private greeting(now: number) {
    const phase = (now - this.tapAt) / 850
    if (phase < 0 || phase >= 1) return 0
    return (this.tapFrom + (1 - this.tapFrom) * smooth(phase / 0.24))
      * (1 - smooth((phase - 0.38) / 0.62))
  }
  tap(now: number) {
    if (!Number.isFinite(now)) return
    // Retrigger from the current pose, not neutral. Repeated taps extend one
    // bounded response; they neither snap the head nor enqueue more gestures.
    this.tapFrom = this.greeting(now)
    this.tapAt = now
  }
  dragAt(x: number | null, now: number) {
    if (x === null || !Number.isFinite(x) || !Number.isFinite(now)) {
      this.pointerX = null; this.pointerAt = -Infinity; this.drive = this.suspension = 0
      return
    }
    const delta = now - this.pointerAt
    this.drive = this.pointerX !== null && delta > 0 && delta <= 150
      ? clamp((x - this.pointerX) / delta / 1.2, 1) * MAX_SUSPENSION : 0
    this.pointerX = x
    this.pointerAt = now
  }
  reset() {
    this.dragAt(null, 0)
    this.resetLook()
    this.lookX = this.lookY = this.tapFrom = 0
    this.tapAt = -Infinity
  }
  apply(motion: PoseMotion, id: PoseId, now: number, milliseconds: number, enabled = true, mirrored = false) {
    if (!enabled) { this.reset(); return }
    const delta = Math.max(0, Math.min(milliseconds, 100))
    const response = 1 - Math.exp(-delta / 140)
    this.lookX += (this.targetX - this.lookX) * response
    this.lookY += (this.targetY - this.lookY) * response
    if (id === 'picked_up') {
      // Only an actual pickup cancels the grounded greeting. A short press
      // also sends drag samples, but must not reset gaze on pointer release.
      this.resetLook()
      this.lookX = this.lookY = this.tapFrom = 0
      this.tapAt = -Infinity
      const target = now - this.pointerAt <= 90 ? this.drive : 0
      this.suspension += (target - this.suspension) * (1 - Math.exp(-delta / 100))
      if (Math.abs(this.suspension) < 0.0001) this.suspension = 0
      motion.suspension = this.suspension
      return
    }
    this.suspension = 0
    if (id === 'dozing') return
    const lookX = this.lookX * (mirrored ? -1 : 1)
    motion.lean += lookX * 1.2
    motion.nod -= this.lookY * 1.2
    motion.headTilt += lookX * 0.009
    constrainPoseMotion(motion)
    const greeting = this.greeting(now)
    // Take over, do not add a second neck gesture. Both endpoints fit the
    // shared budget (6.7 + 180 * .018 < 10), so their interpolation also fits.
    // Keep breathing/blinking and the gaze lean, then return smoothly to the
    // still-running idle schedule when the response fades out.
    motion.lean += (lookX * 1.2 - motion.lean) * greeting
    motion.nod += (6.7 - motion.nod) * greeting
    motion.headTilt += (0.018 - motion.headTilt) * greeting
  }
}

// Randomness schedules occasional gestures, never per-frame jitter. Most of
// the time there is only subtle breathing on the same connected mesh.
export class PoseClock {
  current: PoseId
  seconds = 0
  private blinkSeconds = 0
  private nextBlink = 0
  private blinkAt = -Infinity
  private nextGesture = 0
  private gestureAt = -Infinity
  private gestureDuration = 3.8
  private direction = 1
  private tilted = false
  private breathPeriod = 5.6
  constructor(initial: PoseId = 'standing', private readonly random: () => number = Math.random) {
    this.current = initial
    this.scheduleBlink()
    this.scheduleGesture()
  }
  private between(low: number, high: number) { return low + (high - low) * this.random() }
  private scheduleBlink() {
    this.blinkSeconds = 0
    this.nextBlink = this.between(2.5, 6.5)
    this.blinkAt = -Infinity
  }
  private scheduleGesture() {
    this.nextGesture = this.between(3, 5)
    this.gestureAt = -Infinity
    this.breathPeriod = this.between(4.8, 6.5)
  }
  select(id: PoseId) {
    if (this.current === id) return
    // Awake pose changes preserve blink phase and its next deadline. Rapid
    // reading/standing/drag changes must not leave the pet staring forever.
    if (this.current === 'dozing' || id === 'dozing') this.scheduleBlink()
    this.current = id
    this.seconds = 0
    this.scheduleGesture()
  }
  advance(milliseconds: number, enabled = true): PoseMotion {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError('Invalid clock delta')
    if (!enabled) return stillPoseMotion()
    const delta = Math.min(milliseconds, 100) / 1000
    this.seconds += delta
    const t = this.seconds, id = this.current
    if (id !== 'dozing') this.blinkSeconds += delta
    if (this.blinkSeconds >= this.nextBlink) {
      this.blinkAt = this.blinkSeconds
      this.nextBlink = this.blinkSeconds + this.between(3.1, 7.2)
    }
    if (t >= this.nextGesture) {
      this.gestureAt = t
      this.gestureDuration = id === 'peeking' ? this.between(3.4, 4.8) : id === 'reading' ? 3.6 : 3
      this.direction = this.random() < 0.5 ? -1 : 1
      this.tilted = this.random() < 0.5
      this.nextGesture = t + this.gestureDuration + this.between(10, 18)
    }
    const motion = stillPoseMotion()
    motion.frame = blinkFrame(id, this.blinkSeconds - this.blinkAt)
    // Suspension is drawn into the new complete pose. Do not reuse grounded
    // breathing/nodding deformations that make its sleeves or torso swim.
    if (id === 'picked_up') return motion
    motion.breath = (1 - Math.cos(t * Math.PI * 2 / this.breathPeriod)) / 2 * (id === 'dozing' ? 1.2 : 0.65)
    const gesture = (t - this.gestureAt) / this.gestureDuration
    if (gesture >= 0 && gesture < 1) {
      if (id === 'peeking') {
        const lean = hold(gesture, 0.28, 0.65)
        motion.lean = 3 * lean
        motion.nod = -0.6 * lean
        motion.headTilt = -0.02 * lean
      } else if (id === 'reading') {
        // A brief lift away from the page, hold, then return; the book/hands
        // are below the neck blend and stay connected to the torso.
        const glance = hold(gesture, 0.24, 0.56)
        motion.nod = -5.2 * glance
        motion.headTilt = this.direction * 0.022 * glance
      } else {
        const nod = Math.sin(gesture * Math.PI) ** 2
        motion.nod = nod * (id === 'dozing' ? 3.2 : this.tilted ? 1.8 : 5.4)
        if (id === 'standing') {
          motion.headTilt = this.direction * (this.tilted ? 0.03 * hold(gesture, 0.25, 0.55) : 0.008 * nod)
        }
      }
    }
    return motion
  }
}
