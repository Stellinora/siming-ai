import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { DesktopPetAmbientMode, DesktopPetBubblePlacement, DesktopPetSide } from '../behavior'
import type { DesktopPetVisualState } from '../state'
import { loadPoseImages, manifest, poseArtRect, posesFor, selectPose, type OutfitId } from './contract'
import { HELD_LIFT_PX, PoseClock, poseMotionPadding, PoseReaction } from './motion'
import { normalPeekViewport, poseLookTarget, posePlacement, type PeekViewport } from './placement'
import { PoseRenderer } from './renderer'
import { PoseFramePacer } from './framePacing'
import { imageHitRegion, type PetHitRegion } from '../hitRegion'

export interface PoseCanvasHandle {
  lookAt(clientX: number, clientY: number): void
  resetLook(): void
  tap(): void
  dragAt(screenX: number | null): void
}
export type PetLoadStatus = 'loading' | 'ready' | 'error'
interface Props {
  outfit: OutfitId
  scale: number
  state: DesktopPetVisualState
  ambient: DesktopPetAmbientMode
  bubbleSide: DesktopPetSide
  bubblePlacement: DesktopPetBubblePlacement
  dragging: boolean
  peekLayout?: PeekViewport | null
  onPeekRestored?: (layout: PeekViewport) => void
  onStatusChange?: (status: PetLoadStatus) => void
  onHitRegionChange?: (region: PetHitRegion) => void
}

export const PoseCanvas = forwardRef<PoseCanvasHandle, Props>(function PoseCanvas(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const latest = useRef(props)
  latest.current = props
  const interaction = useRef(new PoseReaction())
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const lookDirty = useRef(false)
  const [status, setStatus] = useState<PetLoadStatus>('loading')
  const [error, setError] = useState('')
  const { onStatusChange, outfit } = props

  useImperativeHandle(ref, () => ({
    lookAt: (clientX, clientY) => {
      // Keep the latest CSS point, not a direction tied to the previous pose.
      // High-rate mouse events do not force synchronous layout reads.
      pointer.current = Number.isFinite(clientX) && Number.isFinite(clientY) ? { x: clientX, y: clientY } : null
      lookDirty.current = true
    },
    resetLook: () => { pointer.current = null; lookDirty.current = false; interaction.current.resetLook() },
    tap: () => interaction.current.tap(performance.now()),
    dragAt: (x) => interaction.current.dragAt(x, performance.now()),
  }), [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const abort = new AbortController()
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const clock = new PoseClock()
    const poses = posesFor(outfit)
    const pacer = new PoseFramePacer()
    let renderer: PoseRenderer | undefined
    let raf = 0
    let width = 1, height = 1, dpr = 1
    let resizePending = true
    let images: Map<string, HTMLImageElement>, hitSignature = ''
    let paintedLayout = '', paintedReduced: boolean | undefined
    let acknowledgedPeek: PeekViewport | undefined
    let frameBounds: DOMRect | undefined
    const report = (next: PetLoadStatus) => { setStatus(next); onStatusChange?.(next) }
    const fail = (reason: unknown) => {
      if (abort.signal.aborted) return
      cancelAnimationFrame(raf)
      abort.abort()
      renderer?.dispose()
      setError(reason instanceof Error ? reason.message : '桌宠姿势加载失败')
      report('error')
    }
    const resize = () => { resizePending = true }
    const measure = () => {
      if (!resizePending) return false
      resizePending = false
      const rect = canvas.getBoundingClientRect()
      frameBounds = rect
      const nextWidth = Math.max(1, rect.width), nextHeight = Math.max(1, rect.height)
      const nextDpr = Math.min(2, window.devicePixelRatio || 1)
      if (width === nextWidth && height === nextHeight && dpr === nextDpr
        && canvas.width === Math.round(nextWidth * nextDpr) && canvas.height === Math.round(nextHeight * nextDpr)) return false
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      dpr = nextDpr
      // Assigning even an unchanged dimension erases the bitmap. Coalesce both
      // resize sources and reset only immediately before painting the new size.
      if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr)
      if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr)
      return true
    }
    const draw = (now: number) => {
      frameBounds = undefined
      const resized = measure()
      const current = latest.current
      const peek = current.peekLayout
      const normal = peek && normalPeekViewport(peek, current.scale)
      // Tasks remain live, but a full-body pose must not enter the compact
      // viewport. Check the actual canvas, including the frame after an early
      // native acknowledgement; do not use an arbitrary delay or shrink art.
      const compact = Boolean(normal && (width < normal.width - 1 || height < normal.height - 1))
      const selected = compact && peek ? { id: 'peeking' as const, edge: peek.side }
        : selectPose(current.state, current.ambient, current.dragging)
      const pose = poses[selected.id]
      const placement = posePlacement(pose, width, height, current.bubbleSide,
        compact ? 'side' : current.bubblePlacement, selected.edge, selected.edge ? peek : null)
      if (peek?.nativeRestored && !compact && !selected.edge && acknowledgedPeek !== peek) {
        acknowledgedPeek = peek
        current.onPeekRestored?.(peek)
      }
      const nextLayout = JSON.stringify([pose.id, width, height, placement])
      const layoutChanged = nextLayout !== paintedLayout
      const reduce = reduced.matches
      const force = layoutChanged || resized || reduce !== paintedReduced
      if (reduce || selected.id === 'dozing') {
        pointer.current = null; lookDirty.current = false; interaction.current.reset()
      } else if (selected.id === 'picked_up') {
        pointer.current = null; lookDirty.current = false
      }
      // A static pose needs no repeated GPU draw. Keep checking for layout or
      // preference changes so it can repaint immediately without reloading.
      if (reduce && !force) return
      clock.select(selected.id)
      const interval = selected.id === 'dozing' ? 50 : 1000 / 30
      const delta = pacer.next(now, interval, force)
      if (delta === null) return
      if (lookDirty.current || (pointer.current && layoutChanged)) {
        const point = pointer.current
        const bounds = point ? frameBounds ?? canvas.getBoundingClientRect() : null
        if (point && bounds && bounds.width > 0 && bounds.height > 0
          && point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom) {
          interaction.current.lookAt(...poseLookTarget(pose, placement, point.x - bounds.left, point.y - bounds.top))
        } else {
          pointer.current = null
          interaction.current.resetLook()
        }
        lookDirty.current = false
      }
      const motion = clock.advance(delta, !reduce)
      interaction.current.apply(motion, selected.id, now, delta, !reduce, selected.edge === 'right')
      const source = renderer!.draw(pose, motion, Math.abs(placement.scaleY) * dpr)
      if (current.onHitRegionChange && nextLayout !== hitSignature) {
        const art = images.get(pose.files[0])
        if (!art) throw new Error(`点击轮廓缺少素材：${pose.id}`)
        current.onHitRegionChange(imageHitRegion(art, width, height, placement, poseArtRect(pose),
          poseMotionPadding(pose, placement.scaleY)))
        hitSignature = nextLayout
      }
      const ctx = canvas.getContext('2d', { alpha: true })
      if (!ctx) throw new Error('无法显示桌宠画布。')
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.setTransform(dpr * placement.scaleX, 0, 0, dpr * placement.scaleY,
        dpr * placement.x, dpr * (placement.y - (selected.id === 'picked_up' && !reduce ? HELD_LIFT_PX : 0)))
      // The renderer may use a 2x backing store; placement always stays in
      // the common logical canvas so resizing never inflates the character.
      canvas.dataset.pose = selected.id
      canvas.dataset.edge = selected.edge || ''
      ctx.drawImage(source, 0, 0, manifest.width, manifest.height)
      canvas.dataset.eyeFrame = String(motion.frame)
      paintedLayout = nextLayout
      paintedReduced = reduce
    }
    const tick = (now: number) => {
      if (abort.signal.aborted) return
      try { draw(now) } catch (reason) { fail(reason); return }
      raf = requestAnimationFrame(tick)
    }
    const visibility = () => {
      cancelAnimationFrame(raf)
      pacer.reset()
      paintedLayout = ''
      pointer.current = null; lookDirty.current = false
      interaction.current.reset()
      if (!document.hidden && renderer && !abort.signal.aborted) raf = requestAnimationFrame(tick)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', visibility)
    report('loading')
    setError('')
    interaction.current.reset()
    void loadPoseImages(abort.signal, outfit).then(loaded => {
      if (abort.signal.aborted) return
      images = loaded
      renderer = new PoseRenderer(images)
      resize()
      draw(performance.now())
      report('ready')
      if (!document.hidden) raf = requestAnimationFrame(tick)
    }).catch(fail)
    return () => {
      abort.abort()
      cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', visibility)
      renderer?.dispose()
    }
  }, [onStatusChange, outfit])

  return <>
    <canvas ref={canvasRef} className="desktop-pet__pose-canvas" aria-hidden="true"
      data-outfit={outfit} data-pose-version={manifest.version} />
    {status !== 'ready' && <span className={`desktop-pet__model-message desktop-pet__model-message--${status}`} title={error || undefined}>
      <i aria-hidden="true" />{status === 'loading' ? '正在唤醒司命' : '司命素材加载失败'}
    </span>}
  </>
})
