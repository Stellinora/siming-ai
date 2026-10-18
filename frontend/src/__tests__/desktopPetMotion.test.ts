import { describe, expect, it } from 'vitest'
import { POSE_IDS, posesFor } from '../features/desktopPet/poses/contract'
import {
  constrainPoseMotion, deformPoint, HELD_LIFT_PX, MAX_HEAD_TILT, MAX_SUSPENSION,
  PoseClock, poseMotionPadding, PoseReaction, stillPoseMotion,
} from '../features/desktopPet/poses/motion'

const poseById = posesFor('classic')

describe('connected pose gestures and pointer reactions', () => {
  it('gives idle a visible neck-anchored tilt, then rests instead of continuously swaying', () => {
    const clock = new PoseClock('standing', () => 0.2)
    let maxTilt = 0, quiet = 0
    for (let tick = 0; tick < 600; tick++) {
      const motion = clock.advance(100)
      maxTilt = Math.max(maxTilt, Math.abs(motion.headTilt))
      if (!motion.nod && !motion.lean && !motion.headTilt) quiet++
    }
    expect(maxTilt).toBeCloseTo(0.03)
    expect(quiet / 600).toBeGreaterThan(0.7)
    const pose = poseById.standing
    const motion = { ...stillPoseMotion(), headTilt: maxTilt }
    const [x] = deformPoint([192, 80], pose, motion)
    expect(Math.abs(x - 192) * 0.387).toBeGreaterThan(2)
    expect(deformPoint([192, pose.neckY], pose, motion)).toEqual([192, pose.neckY])
    const a: [number, number] = [148, 200], b: [number, number] = [210, 200]
    const a2 = deformPoint(a, pose, motion), b2 = deformPoint(b, pose, motion)
    expect(Math.hypot(b2[0] - a2[0], b2[1] - a2[1])).toBeCloseTo(62)
    // The book and sleeves below the neck blend never detach or rotate independently.
    expect(deformPoint([152, 365], pose, motion)).toEqual([152, 365])
  })

  it('reading glances up, holds briefly, and returns to the page', () => {
    const clock = new PoseClock('reading', () => 0.5)
    const samples = Array.from({ length: 100 }, () => clock.advance(100))
    expect(Math.min(...samples.map(m => m.nod))).toBeCloseTo(-5.2)
    expect(samples.filter(m => m.nod < -5).length).toBeGreaterThan(6)
    expect(samples[samples.length - 1].nod).toBe(0)
    expect(samples[samples.length - 1].headTilt).toBe(0)
  })

  it.each(['standing', 'reading', 'peeking'] as const)('lets a tap take over %s automatically instead of adding opposing neck gestures', id => {
    for (const direction of [-1, 1]) {
      const reaction = new PoseReaction()
      reaction.lookAt(direction, -direction)
      reaction.apply(stillPoseMotion(), id, 900, 100)
      reaction.tap(1000)
      const motion = { ...stillPoseMotion(), nod: direction * 5.2, headTilt: direction * 0.03,
        lean: 3, breath: 0.5, frame: 1 }
      reaction.apply(motion, id, 1280, 100)
      expect(motion.nod).toBeCloseTo(6.7)
      expect(motion.headTilt).toBeCloseTo(0.018)
      expect(Math.abs(motion.lean)).toBeLessThan(1.2)
      expect(motion.breath).toBe(0.5)
      expect(motion.frame).toBe(1)
    }
  })

  it('smoothly hands a changing automatic gesture back after the response, within one neck budget', () => {
    const reaction = new PoseReaction()
    const automatic = (now: number) => ({ ...stillPoseMotion(),
      nod: 5 * Math.cos(now / 500), headTilt: 0.04 * Math.sin(now / 500), lean: 3 })
    const neutral = automatic(1000)
    reaction.apply(neutral, 'reading', 1000, 0)
    reaction.tap(1000)
    let previous = neutral
    for (let now = 1000; now <= 1850; now++) {
      const motion = automatic(now)
      reaction.apply(motion, 'reading', now, 1)
      if (now === 1000) expect(motion).toEqual(neutral)
      expect(Math.abs(motion.nod - previous.nod)).toBeLessThan(0.075)
      expect(Math.abs(motion.headTilt - previous.headTilt)).toBeLessThan(0.0007)
      expect(Math.abs(motion.nod) + 180 * Math.abs(motion.headTilt)).toBeLessThanOrEqual(10.00001)
      previous = motion
    }
    const resumed = automatic(1850)
    constrainPoseMotion(resumed)
    expect(previous).toEqual(resumed)
    const expectedPeak = automatic(1250)
    reaction.tap(2000)
    reaction.apply(expectedPeak, 'reading', 2280, 0)
    expect(expectedPeak.nod).toBeCloseTo(6.7)
  })

  it('responds to a tap within the neck budget, then finishes once and restores gaze', () => {
    const reaction = new PoseReaction()
    reaction.lookAt(100, -100)
    reaction.tap(1000)
    const motion = { ...stillPoseMotion(), nod: 5.4, headTilt: 0.03 }
    reaction.apply(motion, 'standing', 1280, 100)
    expect(motion.nod).toBeCloseTo(6.7)
    expect(motion.headTilt).toBeCloseTo(0.018)
    reaction.resetLook()
    for (let i = 0; i < 40; i++) reaction.apply(stillPoseMotion(), 'standing', 2000 + i * 100, 100)
    const settled = stillPoseMotion()
    reaction.apply(settled, 'standing', 6100, 100)
    expect(settled.nod).toBeCloseTo(0)
    expect(settled.headTilt).toBeCloseTo(0)
  })

  it('mirrors pointer response at the right screen edge, not the screen-space target', () => {
    const left = new PoseReaction(), right = new PoseReaction()
    left.lookAt(-1, 1); right.lookAt(-1, 1)
    const a = stillPoseMotion(), b = stillPoseMotion()
    left.apply(a, 'peeking', 100, 100)
    right.apply(b, 'peeking', 100, 100, true, true)
    expect(b.headTilt).toBe(-a.headTilt)
    expect(b.lean).toBe(-a.lean)
    expect(b.nod).toBe(a.nod)
  })

  it('repeats taps continuously at attack, hold and return without stacking or queuing motion', () => {
    const reaction = new PoseReaction()
    reaction.tap(1000)
    const sample = (now: number) => {
      const motion = stillPoseMotion()
      reaction.apply(motion, 'standing', now, 0)
      return motion
    }
    for (const now of [1090, 1370, 1960, 2070, 2300]) {
      const before = sample(now)
      expect(before.nod).toBeGreaterThan(0)
      reaction.tap(now)
      expect(sample(now)).toEqual(before)
    }
    for (let now = 2330; now <= 5300; now += 30) {
      reaction.tap(now)
      const motion = sample(now)
      expect(motion.nod).toBeLessThanOrEqual(7)
      expect(motion.headTilt).toBeLessThanOrEqual(0.018)
    }
    expect(sample(6150)).toEqual(stillPoseMotion())
    expect(sample(10000)).toEqual(stillPoseMotion())
  })

  it('ending a short pointer press preserves the current greeting and gaze', () => {
    const reaction = new PoseReaction()
    reaction.lookAt(-1, 1)
    reaction.tap(1000)
    reaction.dragAt(100, 1000)
    const before = stillPoseMotion()
    reaction.apply(before, 'standing', 1150, 100)
    reaction.dragAt(null, 1150)
    const after = stillPoseMotion()
    reaction.apply(after, 'standing', 1150, 0)
    expect(after).toEqual(before)
    expect(after.lean).toBeLessThan(0)
    reaction.tap(1150)
    const retapped = stillPoseMotion()
    reaction.apply(retapped, 'standing', 1150, 0)
    expect(retapped).toEqual(before)
    reaction.reset()
    const reset = stillPoseMotion()
    reaction.apply(reset, 'standing', 1180, 30)
    expect(reset).toEqual(stillPoseMotion())
  })

  it('cancels a grounded greeting during an actual pickup instead of replaying it after release', () => {
    const reaction = new PoseReaction()
    reaction.lookAt(1, 1)
    reaction.tap(1000)
    reaction.apply(stillPoseMotion(), 'standing', 1200, 100)
    reaction.dragAt(100, 1200)
    reaction.dragAt(180, 1230)
    const held = stillPoseMotion()
    reaction.apply(held, 'picked_up', 1230, 30)
    expect(held.suspension).toBeGreaterThan(0)
    reaction.dragAt(null, 1260)
    const released = stillPoseMotion()
    reaction.apply(released, 'standing', 1300, 70)
    expect(released).toEqual(stillPoseMotion())
  })

  it.each([-1, 1])('suspends the entire pose for screen-space drag direction %s, then settles without oscillating', direction => {
    const reaction = new PoseReaction()
    reaction.dragAt(400, 1000)
    let moving = stillPoseMotion()
    for (let i = 1; i <= 8; i++) {
      reaction.dragAt(400 + direction * 24 * i, 1000 + i * 20)
      moving = stillPoseMotion()
      reaction.apply(moving, 'picked_up', 1000 + i * 20, 20)
    }
    expect(moving.suspension * direction).toBeGreaterThan(0.015)
    expect(Math.abs(moving.suspension)).toBeLessThanOrEqual(MAX_SUSPENSION)
    expect(moving.headTilt).toBe(0)
    const a = deformPoint([140, 320], poseById.picked_up, moving)
    const b = deformPoint([240, 320], poseById.picked_up, moving)
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(100)
    let previous = Math.abs(moving.suspension)
    for (let i = 1; i <= 10; i++) {
      const stopped = stillPoseMotion()
      reaction.apply(stopped, 'picked_up', 1250 + i * 100, 100)
      expect(Math.abs(stopped.suspension)).toBeLessThanOrEqual(previous)
      expect(stopped.suspension * direction).toBeGreaterThanOrEqual(0)
      previous = Math.abs(stopped.suspension)
    }
    expect(previous).toBe(0)
  })

  it('clears held motion on release, cancellation, hidden pages or reduced motion', () => {
    const reaction = new PoseReaction()
    reaction.dragAt(100, 1000)
    reaction.dragAt(200, 1020)
    reaction.apply(stillPoseMotion(), 'picked_up', 1040, 100)
    reaction.dragAt(null, 1040)
    const released = stillPoseMotion()
    reaction.apply(released, 'picked_up', 1060, 100)
    expect(released).toEqual(stillPoseMotion())
    reaction.lookAt(1, 1)
    reaction.tap(1100)
    const reduced = stillPoseMotion()
    reaction.apply(reduced, 'standing', 1200, 100, false)
    expect(reduced).toEqual(stillPoseMotion())
    reaction.apply(reduced, 'standing', 1300, 100)
    expect(reduced).toEqual(stillPoseMotion())
    reaction.dragAt(200, 2000)
    reaction.dragAt(6000, 5000) // A resumed/stale pointer sample is not a fast fling.
    const resumed = stillPoseMotion()
    reaction.apply(resumed, 'picked_up', 5020, 20)
    expect(resumed.suspension).toBe(0)
    reaction.lookAt(NaN, Infinity)
    reaction.dragAt(Infinity, 5030)
    reaction.apply(resumed, 'standing', 5040, 20)
    expect(Object.values(resumed).every(Number.isFinite)).toBe(true)
  })

  it.each(POSE_IDS)('%s preserves connected mesh winding and fits the static motion hit margin at gesture extremes', id => {
    const pose = poseById[id]
    for (const sign of [-1, 1]) {
      const motion = id === 'picked_up'
        ? { ...stillPoseMotion(), suspension: sign * MAX_SUSPENSION }
        : { ...stillPoseMotion(), lean: sign * 4.2, nod: sign * 8, breath: 1.2, headTilt: sign * MAX_HEAD_TILT }
      constrainPoseMotion(motion)
      const [left, top, right, bottom] = pose.visibleBounds
      for (let y = top; y <= bottom; y += 8) for (let x = left; x <= right; x += 8) {
        const p = deformPoint([x, y], pose, motion)
        const a = deformPoint([x + 1, y], pose, motion)
        const b = deformPoint([x, y + 1], pose, motion)
        const area = (a[0] - p[0]) * (b[1] - p[1]) - (a[1] - p[1]) * (b[0] - p[0])
        expect(area).toBeGreaterThan(0.8)
        for (const scale of [0.339, 0.387, 0.654]) {
          const lift = id === 'picked_up' ? HELD_LIFT_PX : 0
          expect(Math.abs(p[0] - x) * scale).toBeLessThan(poseMotionPadding(pose, scale))
          expect(Math.abs(p[1] - y) * scale + lift).toBeLessThan(poseMotionPadding(pose, scale))
        }
      }
      if (id !== 'picked_up') expect(deformPoint([192, 560], pose, motion)).toEqual([192, 560])
    }
  })
})
