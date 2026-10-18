import { createRef, StrictMode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PoseCanvas, type PoseCanvasHandle } from '../features/desktopPet/poses/PoseCanvas'
import { posesFor } from '../features/desktopPet/poses/contract'
import { compactPeekLayout, posePlacement } from '../features/desktopPet/poses/placement'

const poseById = posesFor('classic')

const mocks = vi.hoisted(() => ({ load: vi.fn(), draw: vi.fn(), dispose: vi.fn(), create: vi.fn(), hit: vi.fn() }))
vi.mock('../features/desktopPet/poses/contract', async importOriginal => ({
  ...await importOriginal<typeof import('../features/desktopPet/poses/contract')>(),
  loadPoseImages: mocks.load,
}))
vi.mock('../features/desktopPet/poses/renderer', () => ({
  PoseRenderer: class {
    constructor() { mocks.create() }
    draw = mocks.draw
    dispose = mocks.dispose
  },
}))
vi.mock('../features/desktopPet/hitRegion', async importOriginal => ({
  ...await importOriginal<typeof import('../features/desktopPet/hitRegion')>(),
  imageHitRegion: mocks.hit,
}))
const props = { outfit: 'classic' as const, scale: 0.8, state: 'idle' as const, ambient: 'awake' as const,
  bubbleSide: 'right' as const, bubblePlacement: 'side' as const, dragging: false }
let nextFrame: FrameRequestCallback | undefined
const originalResizeObserver = window.ResizeObserver

beforeEach(() => {
  vi.clearAllMocks()
  mocks.load.mockResolvedValue(new Map())
  mocks.draw.mockImplementation(() => document.createElement('canvas'))
  mocks.hit.mockImplementation((_image, width, height) => ({ width, height, rects: [[0, 0, 10, 10]] }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
  vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { nextFrame = callback; return 1 }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.ResizeObserver = originalResizeObserver; nextFrame = undefined })

describe('desktop pose canvas lifecycle', () => {
  it.each(['classic', 'casual'] as const)('holds %s peeking art until both viewport dimensions recover, keeping the latest task', async outfit => {
    for (const side of ['left', 'right'] as const) {
      for (const reduce of [false, true]) {
        let now = 1000
        vi.spyOn(performance, 'now').mockImplementation(() => now)
        const query = window.matchMedia('(prefers-reduced-motion: reduce)')
        vi.spyOn(window, 'matchMedia').mockReturnValue({ ...query, matches: reduce })
        const peekLayout = { ...compactPeekLayout(272, 240, outfit), side, scale: 0.8, nativeRestored: true }
        let width = peekLayout.width, height = peekLayout.height
        vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect')
          .mockImplementation(() => new DOMRect(0, 0, width, height))
        mocks.load.mockResolvedValue(new Map(Object.values(posesFor(outfit))
          .flatMap(pose => pose.files.map(file => [file, new Image()]))))
        const status = vi.fn(), hit = vi.fn(), restored = vi.fn()
        const common = { ...props, outfit, peekLayout, onStatusChange: status,
          onHitRegionChange: hit, onPeekRestored: restored }
        const view = render(<PoseCanvas {...common} ambient={`peek-${side}`} />)
        await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
        const canvas = view.container.querySelector('canvas')!
        const assertPeek = () => {
          expect(mocks.draw.mock.lastCall?.[0].id).toBe('peeking')
          expect(canvas).toHaveAttribute('data-pose', 'peeking')
          expect(canvas).toHaveAttribute('data-edge', side)
          expect(restored).not.toHaveBeenCalled()
          const placement = mocks.hit.mock.lastCall![3]
          expect(Math.sign(placement.scaleX)).toBe(side === 'left' ? 1 : -1)
          expect(placement.y + posesFor(outfit).peeking.visibleBounds[1] * placement.scaleY).toBeGreaterThan(0)
        }
        assertPeek()
        view.rerender(<PoseCanvas {...common} state="thinking" />)
        act(() => { now += 100; nextFrame?.(now) })
        assertPeek()
        // A bridge acknowledgement is not a resize; newer task state must not
        // overwrite the compact silhouette or get lost behind the visual gate.
        view.rerender(<PoseCanvas {...common} state="writing" />)
        act(() => { window.dispatchEvent(new Event('resize')); now += 100; nextFrame?.(now) })
        assertPeek()
        act(() => { width = 272; window.dispatchEvent(new Event('resize')); now += 100; nextFrame?.(now) })
        assertPeek()
        act(() => { height = 240; window.dispatchEvent(new Event('resize')); now += 1; nextFrame?.(now) })
        expect(mocks.draw.mock.lastCall?.[0].id).toBe('reading')
        expect(canvas).toHaveAttribute('data-pose', 'reading')
        expect(canvas).toHaveAttribute('data-edge', '')
        expect(restored).toHaveBeenCalledExactlyOnceWith(peekLayout)
        const placement = mocks.hit.mock.lastCall![3]
        expect(placement.y + posesFor(outfit).reading.visibleBounds[1] * placement.scaleY).toBeGreaterThan(0)
        view.rerender(<PoseCanvas {...common} peekLayout={null} state="writing" />)
        act(() => { now += 100; nextFrame?.(now) })
        expect(mocks.hit.mock.lastCall![3]).toEqual(placement)
        expect(restored).toHaveBeenCalledTimes(1)
        view.unmount()
      }
    }
  })

  it('keeps the viewport guard for a task arriving before the first compact frame and for pickup', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const peekLayout = { ...compactPeekLayout(272, 240, 'classic'), side: 'right' as const, scale: 0.8, nativeRestored: true }
    let width = peekLayout.width, height = peekLayout.height
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => new DOMRect(0, 0, width, height))
    const status = vi.fn(), restored = vi.fn()
    const common = { ...props, peekLayout, onStatusChange: status, onPeekRestored: restored }
    const view = render(<PoseCanvas {...common} state="writing" />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    expect(mocks.draw.mock.lastCall?.[0].id).toBe('peeking')
    view.rerender(<PoseCanvas {...common} state="writing" dragging />)
    act(() => { now += 100; nextFrame?.(now) })
    expect(mocks.draw.mock.lastCall?.[0].id).toBe('peeking')
    expect(restored).not.toHaveBeenCalled()
    act(() => { width = 272; height = 240; window.dispatchEvent(new Event('resize')); now += 1; nextFrame?.(now) })
    expect(mocks.draw.mock.lastCall?.[0].id).toBe('picked_up')
    expect(restored).toHaveBeenCalledExactlyOnceWith(peekLayout)
  })

  it('does not clear a docking layout before compaction, and accepts a new scale on exit', async () => {
    let now = 1000, width = 272, height = 240
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => new DOMRect(0, 0, width, height))
    const peekLayout = { ...compactPeekLayout(272, 240, 'classic'), side: 'left' as const, scale: 0.8, nativeRestored: false }
    const status = vi.fn(), restored = vi.fn()
    const common = { ...props, peekLayout, onStatusChange: status, onPeekRestored: restored }
    const view = render(<PoseCanvas {...common} ambient="going-left" />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    expect(restored).not.toHaveBeenCalled()
    act(() => { width = peekLayout.width; height = peekLayout.height; window.dispatchEvent(new Event('resize')); now += 100; nextFrame?.(now) })
    expect(mocks.draw.mock.lastCall?.[0].id).toBe('peeking')
    const restoredLayout = { ...peekLayout, nativeRestored: true }
    view.rerender(<PoseCanvas {...common} peekLayout={restoredLayout} scale={0.7} state="error" />)
    act(() => { now += 100; nextFrame?.(now) })
    expect(restored).not.toHaveBeenCalled()
    act(() => { width = 238; height = 210; window.dispatchEvent(new Event('resize')); now += 1; nextFrame?.(now) })
    expect(mocks.draw.mock.lastCall?.[0].id).toBe('standing')
    expect(restored).toHaveBeenCalledExactlyOnceWith(restoredLayout)
  })

  it('acknowledges a late native reply after the expanded frame even with reduced-motion redraws skipped', async () => {
    let now = 1000, width = 207, height = 180
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    vi.spyOn(window, 'matchMedia').mockReturnValue({ ...query, matches: true })
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => new DOMRect(0, 0, width, height))
    const peekLayout = { ...compactPeekLayout(272, 240, 'classic'), side: 'left' as const, scale: 0.8, nativeRestored: false }
    const status = vi.fn(), restored = vi.fn()
    const common = { ...props, state: 'writing' as const, peekLayout, onStatusChange: status, onPeekRestored: restored }
    const view = render(<PoseCanvas {...common} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    act(() => { width = 271.5; height = 239.5; window.dispatchEvent(new Event('resize')); now += 1; nextFrame?.(now) })
    expect(mocks.draw.mock.lastCall?.[0].id).toBe('reading')
    expect(restored).not.toHaveBeenCalled()
    mocks.draw.mockClear()
    const acknowledged = { ...peekLayout, nativeRestored: true }
    view.rerender(<PoseCanvas {...common} peekLayout={acknowledged} />)
    act(() => { now += 1; nextFrame?.(now) })
    expect(restored).toHaveBeenCalledExactlyOnceWith(acknowledged)
    expect(mocks.draw).not.toHaveBeenCalled()
  })

  it('ignores a late previous outfit load and renders only the newly selected set', async () => {
    const pending: ((images: Map<string, HTMLImageElement>) => void)[] = []
    mocks.load.mockImplementation(() => new Promise(resolve => pending.push(resolve)))
    const status = vi.fn()
    const view = render(<PoseCanvas {...props} onStatusChange={status} />)
    view.rerender(<PoseCanvas {...props} outfit="casual" onStatusChange={status} />)
    expect(mocks.load.mock.calls.map(call => call[1])).toEqual(['classic', 'casual'])
    expect(mocks.load.mock.calls[0][0].aborted).toBe(true)
    await act(async () => pending[1](new Map()))
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    await act(async () => pending[0](new Map()))
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.draw.mock.calls[0][0]).toBe(posesFor('casual').standing)
    expect(document.querySelector('canvas')).toHaveAttribute('data-outfit', 'casual')
    view.unmount()
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
  })
  it('releases the old outfit renderer and rebuilds its hit region exactly once on change', async () => {
    mocks.load.mockImplementation(async (_signal, outfit) => new Map(
      Object.values(posesFor(outfit)).flatMap(pose => pose.files.map(file => [file, new Image()]))))
    const status = vi.fn(), hit = vi.fn()
    const view = render(<PoseCanvas {...props} onStatusChange={status} onHitRegionChange={hit} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    view.rerender(<PoseCanvas {...props} outfit="casual" onStatusChange={status} onHitRegionChange={hit} />)
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2))
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
    expect(hit).toHaveBeenCalledTimes(2)
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][0]).toBe(posesFor('casual').standing)
    view.unmount()
    expect(mocks.dispose).toHaveBeenCalledTimes(2)
  })
  it('coalesces resize notifications, paints in the same frame as bitmap reset, and preserves the renderer', async () => {
    let observerCallback: () => void = () => {}
    window.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) { observerCallback = () => callback([], this) }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    let width = 272, height = 240
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => (
      { width, height } as DOMRect
    ))
    const widthSetter = vi.spyOn(HTMLCanvasElement.prototype, 'width', 'set')
    const heightSetter = vi.spyOn(HTMLCanvasElement.prototype, 'height', 'set')
    const status = vi.fn()
    render(<PoseCanvas {...props} onStatusChange={status} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    widthSetter.mockClear(); heightSetter.mockClear(); mocks.draw.mockClear()
    act(() => {
      for (let i = 0; i < 8; i++) { window.dispatchEvent(new Event('resize')); observerCallback() }
      nextFrame?.(performance.now() + 100)
    })
    expect(widthSetter).not.toHaveBeenCalled()
    expect(heightSetter).not.toHaveBeenCalled()
    act(() => {
      width = 340; height = 300
      window.dispatchEvent(new Event('resize')); observerCallback()
      width = 459; height = 405
      window.dispatchEvent(new Event('resize')); observerCallback()
    })
    expect(widthSetter).not.toHaveBeenCalled()
    const before = mocks.draw.mock.calls.length
    act(() => nextFrame?.(performance.now() + 101))
    expect(widthSetter).toHaveBeenCalledExactlyOnceWith(459)
    expect(heightSetter).toHaveBeenCalledExactlyOnceWith(405)
    expect(mocks.draw).toHaveBeenCalledTimes(before + 1)
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.load).toHaveBeenCalledTimes(1)
  })
  it('switches to the lifted sprite during drag and back to the live task without reloading textures', async () => {
    const status = vi.fn()
    const view = render(<PoseCanvas {...props} state="writing" onStatusChange={status} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    view.rerender(<PoseCanvas {...props} state="writing" dragging onStatusChange={status} />)
    act(() => nextFrame?.(performance.now() + 100))
    expect(document.querySelector('canvas[data-pose]')).toHaveAttribute('data-pose', 'picked_up')
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1]?.[0].id).toBe('picked_up')
    view.rerender(<PoseCanvas {...props} state="writing" onStatusChange={status} />)
    act(() => nextFrame?.(performance.now() + 200))
    expect(document.querySelector('canvas[data-pose]')).toHaveAttribute('data-pose', 'reading')
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1]?.[0].id).toBe('reading')
    expect(mocks.load).toHaveBeenCalledTimes(1)
  })
  it('requests physical render density but always composites into the fixed logical art size', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 459, height: 405 } as DOMRect)
    const source = document.createElement('canvas')
    source.width = 768; source.height = 1152
    mocks.draw.mockReturnValue(source)
    const drawImage = vi.fn()
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      setTransform: vi.fn(), clearRect: vi.fn(), drawImage,
    } as unknown as CanvasRenderingContext2D)
    const status = vi.fn()
    render(<PoseCanvas {...props} onStatusChange={status} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    expect(mocks.draw.mock.calls[0][2]).toBeCloseTo(459 * 0.49 / 344 * 2)
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 384, 576)
  })
  it('converts client coordinates using the canvas and current face placement, not its backing-store density', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('devicePixelRatio', 2)
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(80, 40, 272, 240))
    const ref = createRef<PoseCanvasHandle>(), status = vi.fn()
    const view = render(<PoseCanvas {...props} ref={ref} onStatusChange={status} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    const point = (side: 'left' | 'right') => {
      const t = posePlacement(poseById.standing, 272, 240, side, 'side', null)
      return [80 + t.x + 192 * t.scaleX, 40 + t.y + 217 * t.scaleY]
    }
    let [x, y] = point('right')
    act(() => { ref.current?.lookAt(x, y); now += 100; nextFrame?.(now) })
    let motion = mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1]
    expect(motion.lean).toBeCloseTo(0)
    expect(motion.headTilt).toBeCloseTo(0)
    expect(motion.nod).toBeCloseTo(0)
    view.rerender(<PoseCanvas {...props} bubbleSide="left" ref={ref} onStatusChange={status} />)
    ;[x, y] = point('left')
    act(() => { ref.current?.lookAt(x, y); now += 100; nextFrame?.(now) })
    motion = mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1]
    expect(motion.lean).toBeCloseTo(0)
    act(() => { ref.current?.lookAt(x + 20, y); now += 100; nextFrame?.(now) })
    motion = mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1]
    expect(motion.lean).toBeGreaterThan(0)
    expect(motion.headTilt).toBeGreaterThan(0)
    expect(mocks.load).toHaveBeenCalledTimes(1)
  })
  it('keeps a tap continuous through a short press release and a second tap', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const ref = createRef<PoseCanvasHandle>(), status = vi.fn()
    render(<PoseCanvas {...props} ref={ref} onStatusChange={status} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    act(() => { ref.current?.tap(); now += 150; nextFrame?.(now) })
    const before = mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1]
    expect(before.nod).toBeGreaterThan(4)
    act(() => {
      ref.current?.dragAt(100); ref.current?.dragAt(null); ref.current?.tap()
      now += 34; nextFrame?.(now)
    })
    const after = mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1]
    expect(after.nod).toBeGreaterThanOrEqual(before.nod)
    expect(after.headTilt).toBeGreaterThanOrEqual(before.headTilt)
    act(() => { now += 851; nextFrame?.(now) })
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1].nod).toBe(0)
  })
  it('reprojects a stationary pointer after bubble-side, size and pose changes', async () => {
    let now = 1000, width = 272, height = 240
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(80, 40, width, height))
    const ref = createRef<PoseCanvasHandle>(), status = vi.fn()
    const view = render(<PoseCanvas {...props} ref={ref} onStatusChange={status} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    const t = posePlacement(poseById.standing, width, height, 'right', 'side', null)
    act(() => { ref.current?.lookAt(80 + t.x + 192 * t.scaleX, 40 + t.y + 217 * t.scaleY); now += 100; nextFrame?.(now) })
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1].lean).toBeCloseTo(0)
    view.rerender(<PoseCanvas {...props} bubbleSide="left" ref={ref} onStatusChange={status} />)
    act(() => { now += 100; nextFrame?.(now) })
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1].lean).toBeLessThan(-0.5)
    view.rerender(<PoseCanvas {...props} ref={ref} onStatusChange={status} />)
    act(() => { width = 200; height = 180; window.dispatchEvent(new Event('resize')); now += 100; nextFrame?.(now) })
    for (let i = 0; i < 10; i++) act(() => { now += 100; nextFrame?.(now) })
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1].lean).toBeGreaterThan(0.5)
    view.rerender(<PoseCanvas {...props} state="writing" ref={ref} onStatusChange={status} />)
    act(() => { now += 100; nextFrame?.(now) })
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1].lean).toBeGreaterThan(0.9)
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })

  it('lets a tap visibly take over a reading glance and restores the live task after pickup', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const ref = createRef<PoseCanvasHandle>(), status = vi.fn()
    const view = render(<PoseCanvas {...props} state="writing" ref={ref} onStatusChange={status} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    const latestMotion = () => mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1]
    for (let i = 0; i < 55; i++) act(() => { now += 100; nextFrame?.(now) })
    expect(latestMotion().nod).toBeLessThan(-5)
    const before = latestMotion()
    act(() => { ref.current?.tap(); now += 1; nextFrame?.(now) })
    expect(latestMotion()).toEqual(before)
    act(() => { now += 279; nextFrame?.(now) })
    expect(latestMotion().nod).toBeCloseTo(6.7)
    expect(latestMotion().headTilt).toBeCloseTo(0.018)
    act(() => { ref.current?.dragAt(100); now += 20; ref.current?.dragAt(124) })
    view.rerender(<PoseCanvas {...props} state="writing" dragging ref={ref} onStatusChange={status} />)
    act(() => { now += 20; nextFrame?.(now) })
    expect(latestMotion().suspension).toBeGreaterThan(0)
    expect(latestMotion().nod).toBe(0)
    act(() => ref.current?.dragAt(null))
    view.rerender(<PoseCanvas {...props} state="writing" ref={ref} onStatusChange={status} />)
    act(() => { now += 1; nextFrame?.(now) })
    expect(latestMotion().nod).toBe(0)
    expect(latestMotion().headTilt).toBe(0)
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][0].id).toBe('reading')
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.load).toHaveBeenCalledTimes(1)
  })
  it('coalesces pointer geometry reads to the latest sample of a rendered frame', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const bounds = vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 272, 240))
    const ref = createRef<PoseCanvasHandle>(), status = vi.fn()
    render(<PoseCanvas {...props} ref={ref} onStatusChange={status} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    bounds.mockClear()
    act(() => {
      for (let i = 0; i < 100; i++) ref.current?.lookAt(20 + i, 100)
    })
    expect(bounds).not.toHaveBeenCalled()
    act(() => { now += 100; nextFrame?.(now) })
    expect(bounds).toHaveBeenCalledTimes(1)
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1].lean).toBeGreaterThan(0)
    for (let i = 0; i < 10; i++) act(() => { now += 100; nextFrame?.(now) })
    expect(bounds).toHaveBeenCalledTimes(1)
    act(() => ref.current?.resetLook())
    for (let i = 0; i < 10; i++) act(() => { now += 100; nextFrame?.(now) })
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1].lean).toBeCloseTo(0)
  })
  it('repaints and updates the silhouette on the next RAF when only the mirrored edge changes', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 272, height: 240 } as DOMRect)
    mocks.load.mockResolvedValue(new Map([[poseById.peeking.files[0], new Image()]]))
    const status = vi.fn(), hit = vi.fn()
    const view = render(<PoseCanvas {...props} ambient="peek-left" onStatusChange={status} onHitRegionChange={hit} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    mocks.draw.mockClear(); mocks.hit.mockClear(); hit.mockClear()
    view.rerender(<PoseCanvas {...props} ambient="peek-right" onStatusChange={status} onHitRegionChange={hit} />)
    act(() => { now += 1; nextFrame?.(now) })
    expect(mocks.draw).toHaveBeenCalledTimes(1)
    expect(mocks.hit).toHaveBeenCalledTimes(1)
    expect(mocks.hit.mock.calls[0][3].scaleX).toBeLessThan(0)
    expect(hit).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 10; i++) act(() => { now += 40; nextFrame?.(now) })
    expect(mocks.hit).toHaveBeenCalledTimes(1)
  })
  it('discards a remembered pointer outside a shrunken viewport and after page visibility changes', async () => {
    let now = 1000, width = 272, hidden = false
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, width, 240))
    const ref = createRef<PoseCanvasHandle>(), status = vi.fn()
    render(<PoseCanvas {...props} ref={ref} onStatusChange={status} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    act(() => { ref.current?.lookAt(200, 100); now += 100; nextFrame?.(now) })
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1].lean).toBeGreaterThan(0.5)
    act(() => { width = 180; window.dispatchEvent(new Event('resize')); now += 100; nextFrame?.(now) })
    for (let i = 0; i < 15; i++) act(() => { now += 100; nextFrame?.(now) })
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1].lean).toBeCloseTo(0)
    act(() => { width = 272; window.dispatchEvent(new Event('resize')); now += 100; nextFrame?.(now) })
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1].lean).toBeCloseTo(0)
    act(() => { ref.current?.lookAt(200, 100); now += 100; nextFrame?.(now) })
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1].lean).toBeGreaterThan(0.5)
    act(() => {
      hidden = true; document.dispatchEvent(new Event('visibilitychange'))
      hidden = false; document.dispatchEvent(new Event('visibilitychange'))
      now += 100; nextFrame?.(now)
    })
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1].lean).toBe(0)
    expect(mocks.load).toHaveBeenCalledTimes(1)
  })
  it('keeps reduced motion static without redrawing the same bitmap, but repaints layout and preference changes', async () => {
    let now = 1000, reduce = true
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    vi.spyOn(window, 'matchMedia').mockReturnValue({ ...query, get matches() { return reduce } })
    const ref = createRef<PoseCanvasHandle>(), status = vi.fn()
    const view = render(<PoseCanvas {...props} ref={ref} onStatusChange={status} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    mocks.draw.mockClear()
    for (let i = 0; i < 20; i++) act(() => { ref.current?.tap(); now += 100; nextFrame?.(now) })
    expect(mocks.draw).not.toHaveBeenCalled()
    view.rerender(<PoseCanvas {...props} bubbleSide="left" ref={ref} onStatusChange={status} />)
    act(() => { now += 1; nextFrame?.(now) })
    expect(mocks.draw).toHaveBeenCalledTimes(1)
    act(() => { reduce = false; now += 1; nextFrame?.(now) })
    expect(mocks.draw).toHaveBeenCalledTimes(2)
    const motion = mocks.draw.mock.calls[1][1]
    expect(motion.nod).toBe(0)
    expect(motion.headTilt).toBe(0)
  })
  it('feeds held screen velocity to the renderer and clears it on release without recreating textures', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const ref = createRef<PoseCanvasHandle>(), status = vi.fn()
    const view = render(<PoseCanvas {...props} ref={ref} onStatusChange={status} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    act(() => ref.current?.dragAt(100))
    view.rerender(<PoseCanvas {...props} dragging ref={ref} onStatusChange={status} />)
    act(() => { now += 50; ref.current?.dragAt(170); nextFrame?.(now) })
    const moving = mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1]
    expect(moving.suspension).toBeGreaterThan(0)
    expect(moving.headTilt).toBe(0)
    for (let i = 0; i < 10; i++) act(() => { now += 100; nextFrame?.(now) })
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1].suspension).toBe(0)
    act(() => ref.current?.dragAt(null))
    view.rerender(<PoseCanvas {...props} ref={ref} onStatusChange={status} />)
    act(() => { now += 100; nextFrame?.(now) })
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][0].id).toBe('standing')
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1].suspension).toBe(0)
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.load).toHaveBeenCalledTimes(1)
  })
  it('keeps reduced-motion output still even when tapped, hovered or dragged', async () => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    vi.spyOn(window, 'matchMedia').mockReturnValue({ ...query, matches: true })
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const ref = createRef<PoseCanvasHandle>(), status = vi.fn()
    const view = render(<PoseCanvas {...props} ref={ref} onStatusChange={status} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    act(() => { ref.current?.tap(); ref.current?.lookAt(1, 1); ref.current?.dragAt(100) })
    view.rerender(<PoseCanvas {...props} dragging ref={ref} onStatusChange={status} />)
    act(() => { now += 50; ref.current?.dragAt(180); nextFrame?.(now) })
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1][1]).toEqual({
      lean: 0, nod: 0, breath: 0, frame: 0, headTilt: 0, suspension: 0,
    })
  })
  it('loads once, forwards interactions, changes poses without texture reload, then releases the renderer', async () => {
    const ref = createRef<PoseCanvasHandle>()
    const status = vi.fn()
    const view = render(<PoseCanvas {...props} ref={ref} onStatusChange={status} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('ready'))
    expect(mocks.draw.mock.calls[0][0].id).toBe('standing')
    act(() => { ref.current?.lookAt(1, 1); ref.current?.tap() })
    view.rerender(<PoseCanvas {...props} state="writing" ref={ref} onStatusChange={status} />)
    act(() => nextFrame?.(performance.now() + 100))
    expect(mocks.draw.mock.calls[mocks.draw.mock.calls.length - 1]?.[0].id).toBe('reading')
    expect(mocks.load).toHaveBeenCalledTimes(1)
    act(() => ref.current?.resetLook())
    view.unmount()
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
    expect(mocks.load.mock.calls[0][0].aborted).toBe(true)
  })
  it('does not create a renderer after unmount while assets are loading', async () => {
    let finish: (value: Map<string, HTMLImageElement>) => void = () => {}
    mocks.load.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const view = render(<PoseCanvas {...props} />)
    view.unmount()
    await act(async () => finish(new Map()))
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('does not leak a duplicate renderer under React StrictMode', async () => {
    const view = render(<StrictMode><PoseCanvas {...props} /></StrictMode>)
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    expect(mocks.load.mock.calls[0][0].aborted).toBe(true)
    view.unmount()
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
  })
  it('reports missing art without silently restoring the retired model', async () => {
    mocks.load.mockRejectedValue(new Error('missing eye frame'))
    const status = vi.fn()
    render(<PoseCanvas {...props} onStatusChange={status} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('error'))
    expect(screen.getByText('司命素材加载失败')).toHaveAttribute('title', 'missing eye frame')
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('reports render failure and stops the loop', async () => {
    mocks.draw.mockImplementation(() => { throw new Error('context lost') })
    const status = vi.fn()
    render(<PoseCanvas {...props} onStatusChange={status} />)
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('error'))
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })
})
