import { describe, expect, it, vi } from 'vitest'
import { NativePetDragController } from '../features/desktopPet/nativeDrag'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function flush() {
  // Drain bridge/controller microtasks without depending on elapsed wall time.
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function setup() {
  const bridge = {
    begin: vi.fn(async (_x: number, _y: number) => true),
    move: vi.fn(async (_x: number, _y: number) => true),
    end: vi.fn(async () => true),
  }
  return { bridge, controller: new NativePetDragController(bridge) }
}

describe('desktop pet native drag transport', () => {
  it('holds only the latest position while begin is pending and applies release before end', async () => {
    const { bridge, controller } = setup()
    const starting = deferred<boolean>()
    bridge.begin.mockReturnValueOnce(starting.promise)
    const drag = controller.begin(10, 20)
    await flush()
    for (let i = 0; i < 500; i++) drag.move(i, i + 20)
    const done = drag.finish()
    drag.move(999, 999)
    expect(bridge.move).not.toHaveBeenCalled()
    starting.resolve(true)
    expect(await done).toBe(true)
    expect(bridge.move).toHaveBeenCalledExactlyOnceWith(499, 519)
    expect(bridge.end).toHaveBeenCalledTimes(1)
    expect(bridge.end.mock.invocationCallOrder[0]).toBeGreaterThan(bridge.move.mock.invocationCallOrder[0])
  })

  it('keeps one move in flight and one newest point, deduplicating an unchanged release', async () => {
    const { bridge, controller } = setup()
    const moving = deferred<boolean>()
    bridge.move.mockReturnValueOnce(moving.promise)
    const drag = controller.begin(10, 20)
    drag.move(30, 40)
    await flush()
    for (let i = 0; i < 500; i++) drag.move(i, i + 40)
    expect(bridge.move).toHaveBeenCalledTimes(1)
    moving.resolve(true)
    await flush()
    expect(bridge.move).toHaveBeenNthCalledWith(2, 499, 539)
    drag.move(499, 539)
    const done = drag.finish()
    expect(drag.finish()).toBe(done)
    expect(await done).toBe(true)
    expect(bridge.move).toHaveBeenCalledTimes(2)
    expect(bridge.end).toHaveBeenCalledTimes(1)
  })

  it.each(['false', 'rejected'] as const)('ends after a %s move and stops pending work, allowing the next gesture', async failure => {
    const { bridge, controller } = setup()
    if (failure === 'false') bridge.move.mockResolvedValueOnce(false)
    else bridge.move.mockRejectedValueOnce(new Error('move failed'))
    const drag = controller.begin(10, 20)
    drag.move(30, 40)
    await flush()
    drag.move(90, 100)
    expect(await drag.finish()).toBe(false)
    expect(bridge.move).toHaveBeenCalledTimes(1)
    expect(bridge.end).toHaveBeenCalledTimes(1)
    expect(await controller.begin(60, 70).finish()).toBe(true)
    expect(bridge.begin).toHaveBeenLastCalledWith(60, 70)
    expect(bridge.end).toHaveBeenCalledTimes(2)
  })

  it('does not move or end a rejected acquisition reported as false', async () => {
    const { bridge, controller } = setup()
    bridge.begin.mockResolvedValueOnce(false)
    const drag = controller.begin(10, 20)
    drag.move(30, 40)
    expect(await drag.finish()).toBe(false)
    expect(bridge.move).not.toHaveBeenCalled()
    expect(bridge.end).not.toHaveBeenCalled()
  })

  it('cleans up an unknown begin outcome before the next begin', async () => {
    const { bridge, controller } = setup()
    bridge.begin.mockRejectedValueOnce(new Error('response lost'))
    expect(await controller.begin(10, 20).finish()).toBe(false)
    expect(bridge.end).toHaveBeenCalledTimes(1)
    expect(await controller.begin(30, 40).finish()).toBe(true)
    expect(bridge.begin.mock.invocationCallOrder[1]).toBeGreaterThan(bridge.end.mock.invocationCallOrder[0])
  })

  it.each(['false', 'rejected'] as const)('does not stick or reject its completion when end is %s', async failure => {
    const { bridge, controller } = setup()
    if (failure === 'false') bridge.end.mockResolvedValueOnce(false)
    else bridge.end.mockRejectedValueOnce(new Error('end failed'))
    expect(await controller.begin(10, 20).finish()).toBe(false)
    expect(await controller.begin(30, 40).finish()).toBe(true)
    expect(bridge.end).toHaveBeenCalledTimes(2)
  })

  it('skips a cancelled gesture which has not acquired the native lane yet', async () => {
    const { bridge, controller } = setup()
    const drag = controller.begin(10, 20)
    drag.move(30, 40)
    expect(await drag.cancel()).toBe(false)
    expect(bridge.begin).not.toHaveBeenCalled()
    expect(bridge.end).not.toHaveBeenCalled()
  })

  it('ends a cancelled late acquisition without moving to old pending coordinates', async () => {
    const { bridge, controller } = setup()
    const starting = deferred<boolean>()
    bridge.begin.mockReturnValueOnce(starting.promise)
    const drag = controller.begin(10, 20)
    await flush()
    drag.move(30, 40)
    const cancelled = drag.cancel()
    starting.resolve(true)
    expect(await cancelled).toBe(false)
    expect(bridge.move).not.toHaveBeenCalled()
    expect(bridge.end).toHaveBeenCalledTimes(1)
  })

  it('drops pending moves on cancel but waits for an in-flight move before ending', async () => {
    const { bridge, controller } = setup()
    const moving = deferred<boolean>()
    bridge.move.mockReturnValueOnce(moving.promise)
    const drag = controller.begin(10, 20)
    drag.move(30, 40)
    await flush()
    drag.move(50, 60)
    const cancelled = drag.cancel()
    expect(bridge.end).not.toHaveBeenCalled()
    moving.resolve(true)
    expect(await cancelled).toBe(false)
    expect(bridge.move).toHaveBeenCalledExactlyOnceWith(30, 40)
    expect(bridge.end).toHaveBeenCalledTimes(1)
  })

  it('serializes rapid re-grabs behind the full prior end, including a false end response', async () => {
    const { bridge, controller } = setup()
    const ending = deferred<boolean>()
    bridge.end.mockReturnValueOnce(ending.promise)
    const first = controller.begin(10, 20)
    first.move(30, 40)
    void first.finish()
    await flush()
    const second = controller.begin(30, 40)
    second.move(60, 80)
    const secondDone = second.finish()
    await flush()
    expect(bridge.begin).toHaveBeenCalledTimes(1)
    ending.resolve(false)
    expect(await secondDone).toBe(true)
    expect(bridge.begin).toHaveBeenNthCalledWith(2, 30, 40)
    expect(bridge.move).toHaveBeenNthCalledWith(2, 60, 80)
  })

  it('cancels queued sessions on teardown and can be reused after effect re-setup', async () => {
    const { bridge, controller } = setup()
    const ending = deferred<boolean>()
    bridge.end.mockReturnValueOnce(ending.promise)
    const first = controller.begin(10, 20)
    void first.finish()
    await flush()
    const queued = controller.begin(30, 40)
    queued.move(50, 60)
    controller.cancelAll()
    ending.resolve(true)
    expect(await queued.done).toBe(false)
    expect(bridge.begin).toHaveBeenCalledTimes(1)
    expect(bridge.move).not.toHaveBeenCalled()
    expect(await controller.begin(70, 80).finish()).toBe(true)
  })

  it('does not send non-finite positions to the native bridge', async () => {
    const { bridge, controller } = setup()
    expect(await controller.begin(NaN, 20).finish()).toBe(false)
    const drag = controller.begin(10, 20)
    drag.move(30, 40)
    drag.move(Infinity, 90)
    expect(await drag.finish()).toBe(true)
    expect(bridge.begin).toHaveBeenCalledExactlyOnceWith(10, 20)
    expect(bridge.move).toHaveBeenCalledExactlyOnceWith(30, 40)
  })
})
