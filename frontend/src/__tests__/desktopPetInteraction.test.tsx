import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DesktopPetApp from '../features/desktopPet/DesktopPetApp'
import type { PeekViewport } from '../features/desktopPet/poses/placement'
import { PET_SPEECH_VISIBLE_MS, PET_SPEECH_FADE_MS, useDesktopPetSpeech } from '../features/desktopPet/useDesktopPetSpeech'

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
}))

const operationMocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  data: [] as unknown[],
  isError: false,
}))

const poseMocks = vi.hoisted(() => ({
  lookAt: vi.fn(),
  resetLook: vi.fn(),
  tap: vi.fn(),
  dragAt: vi.fn(),
  render: vi.fn(),
}))

vi.mock('../shared/api/client', () => ({
  apiClient: apiMocks,
}))

vi.mock('../features/operations', () => ({
  operationKeys: { list: (limit: number) => ['operations', limit] },
  updateOperationInCache: vi.fn(),
  useOperations: () => ({
    data: operationMocks.data,
    isError: operationMocks.isError,
    refetch: operationMocks.refetch,
  }),
}))

vi.mock('../features/desktopPet/poses/PoseCanvas', async () => {
  const React = await import('react')
  interface MockPoseProps {
    outfit: string
    scale: number
    onStatusChange?: (status: 'ready') => void
    state: string
    ambient: string
    peekLayout?: PeekViewport | null
    onPeekRestored?: (layout: PeekViewport) => void
  }
  interface MockPoseHandle {
    lookAt(clientX: number, clientY: number): void
    resetLook(): void
    tap(): void
    dragAt(screenX: number | null): void
  }
  return {
    PoseCanvas: React.forwardRef<MockPoseHandle, MockPoseProps>(
      function MockPoseCanvas(props, ref) {
        const { onStatusChange, state, ambient, outfit } = props
        poseMocks.render(props)
        React.useImperativeHandle(ref, () => poseMocks, [])
        React.useEffect(() => onStatusChange?.('ready'), [onStatusChange])
        return React.createElement('canvas', {
          'aria-hidden': true,
          'data-visual-state': state,
          'data-outfit': outfit,
          'data-ambient': ambient,
        })
      },
    ),
  }
})

function renderDesktopPet() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <DesktopPetApp />
    </QueryClientProvider>,
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete window.pywebview
})

describe('desktop pet pointer interaction', () => {
  const nativeApi = {
    begin_desktop_pet_drag: vi.fn(async () => true),
    move_desktop_pet_drag: vi.fn(async () => true),
    end_desktop_pet_drag: vi.fn(async () => true),
    show_main_window: vi.fn(async () => true),
    hide_desktop_pet: vi.fn(async () => true),
    show_desktop_pet: vi.fn(async () => true),
    apply_desktop_pet_preferences: vi.fn(async () => true),
    cancel_desktop_pet_edge_move: vi.fn(async () => true),
    move_desktop_pet_to_edge: vi.fn<(
      side: 'left' | 'right',
      compact: { width: number; height: number; viewport_width: number; viewport_height: number },
    ) => Promise<import('../features/desktopPet/behavior').DesktopPetWindowContext | null>>(),
    get_desktop_pet_window_context: vi.fn(async () => ({
      x: 600,
      y: 200,
      width: 360,
      height: 520,
      work_x: 0,
      work_y: 0,
      work_width: 1920,
      work_height: 1040,
    })),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    nativeApi.begin_desktop_pet_drag.mockReset().mockResolvedValue(true)
    nativeApi.move_desktop_pet_drag.mockReset().mockResolvedValue(true)
    nativeApi.end_desktop_pet_drag.mockReset().mockResolvedValue(true)
    nativeApi.cancel_desktop_pet_edge_move.mockReset().mockResolvedValue(true)
    vi.spyOn(Math, 'random').mockReturnValue(0.1)
    nativeApi.move_desktop_pet_to_edge.mockImplementation(async (side) => {
      const context = await nativeApi.get_desktop_pet_window_context()
      const next = { ...context, x: side === 'left' ? context.work_x : context.work_x + context.work_width - context.width }
      nativeApi.get_desktop_pet_window_context.mockResolvedValue(next)
      return next
    })
    operationMocks.data = []
    operationMocks.isError = false
    nativeApi.get_desktop_pet_window_context.mockResolvedValue({
      x: 600,
      y: 200,
      width: 360,
      height: 520,
      work_x: 0,
      work_y: 0,
      work_width: 1920,
      work_height: 1040,
    })
    apiMocks.get.mockResolvedValue({
      data: {
        data: {
          desktop_pet_enabled: true,
          desktop_pet_outfit: 'classic',
          desktop_pet_scale: 1,
          desktop_pet_opacity: 0.96,
          desktop_pet_muted: true,
          desktop_pet_on_top: true,
          desktop_pet_runtime_active: true,
        },
      },
    })
    apiMocks.put.mockImplementation(async (_url, patch) => ({ data: { data: {
      ...((await apiMocks.get()).data.data), ...patch,
    } } }))
    window.pywebview = { api: nativeApi }
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('EventSource', class {
      addEventListener = vi.fn()
      close = vi.fn()
    })
  })

  it('previews the size slider before release, then saves once for mouse and keyboard gestures', async () => {
    renderDesktopPet()
    await act(async () => {})
    fireEvent.contextMenu(screen.getByRole('button', { name: /单击换一句悄悄话/ }))
    const slider = screen.getByRole('slider', { name: '桌宠大小' })
    Object.defineProperties(slider, {
      setPointerCapture: { value: vi.fn() },
      hasPointerCapture: { value: vi.fn(() => false) },
    })
    expect(slider).toHaveAttribute('step', '0.01')
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 100 } as DOMRect)
    fireEvent.pointerDown(slider, { button: 0, buttons: 1, pointerId: 19, clientX: 46.77, screenX: 300 })
    fireEvent.pointerMove(window, { pointerId: 19, buttons: 1, screenX: 325.85 })
    await waitFor(() => expect(nativeApi.apply_desktop_pet_preferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ desktop_pet_scale: 1.2 }), false, { x: 'right', y: 'bottom' },
    ))
    expect(apiMocks.put).not.toHaveBeenCalled()
    fireEvent.pointerUp(window, { pointerId: 19, screenX: 325.85 })
    await waitFor(() => expect(apiMocks.put).toHaveBeenCalledExactlyOnceWith('/config/launcher', { desktop_pet_scale: 1.2 }))
    fireEvent.blur(slider)
    await act(async () => {})
    expect(apiMocks.put).toHaveBeenCalledTimes(1)
    fireEvent.change(slider, { target: { value: '1.21' } })
    fireEvent.keyUp(slider, { key: 'ArrowRight' })
    await waitFor(() => expect(apiMocks.put).toHaveBeenLastCalledWith('/config/launcher', { desktop_pet_scale: 1.21 }))
  })

  it('selects an outfit through the shared saved preference without touching task state or scale', async () => {
    renderDesktopPet()
    await act(async () => {})
    fireEvent.contextMenu(screen.getByRole('button', { name: /单击换一句悄悄话/ }))
    fireEvent.change(screen.getByRole('combobox', { name: '桌宠衣装' }), { target: { value: 'casual' } })
    await waitFor(() => expect(apiMocks.put).toHaveBeenCalledExactlyOnceWith('/config/launcher', { desktop_pet_outfit: 'casual' }))
    expect(document.querySelector('canvas')).toHaveAttribute('data-outfit', 'casual')
    expect(document.querySelector('main')).toHaveAttribute('data-desktop-pet-state', 'idle')
    expect(screen.getByRole('slider', { name: '桌宠大小' })).toHaveValue('1')
  })

  it('keeps a short press interactive without invoking native movement', async () => {
    renderDesktopPet()
    const character = screen.getByRole('button', { name: /单击换一句悄悄话/ })

    expect(character).not.toHaveClass('pywebview-drag-region')
    expect(screen.queryByLabelText('桌宠悄悄话')).not.toBeInTheDocument()
    fireEvent.pointerDown(character, {
      button: 0,
      pointerId: 1,
      screenX: 100,
      screenY: 100,
    })
    fireEvent.pointerUp(character, {
      button: 0,
      pointerId: 1,
      screenX: 103,
      screenY: 102,
    })

    expect(screen.getByLabelText('桌宠悄悄话')).toHaveTextContent('小书抱好啦')
    expect(poseMocks.tap).toHaveBeenCalledTimes(1)
    expect(nativeApi.move_desktop_pet_drag).not.toHaveBeenCalled()
    await waitFor(() => expect(nativeApi.end_desktop_pet_drag).toHaveBeenCalledTimes(1))
  })

  it('forwards viewport pointer coordinates without normalizing against the transparent button', async () => {
    renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    vi.spyOn(character, 'getBoundingClientRect').mockReturnValue({ left: 80, top: 40, width: 272, height: 240 } as DOMRect)
    fireEvent.pointerMove(character, { pointerId: 1, clientX: 148, clientY: 130 })
    expect(poseMocks.lookAt).toHaveBeenLastCalledWith(148, 130)
  })

  it('moves the native window after the drag threshold without treating it as a tap', async () => {
    renderDesktopPet()
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })

    fireEvent.pointerDown(character, {
      button: 0,
      pointerId: 7,
      screenX: 200,
      screenY: 160,
    })
    fireEvent.pointerMove(character, {
      pointerId: 7,
      buttons: 1,
      screenX: 224,
      screenY: 176,
      clientX: 180,
      clientY: 250,
    })
    expect(character.closest('main')).toHaveClass('desktop-pet--dragging')
    expect(poseMocks.dragAt).toHaveBeenNthCalledWith(1, 200)
    expect(poseMocks.dragAt).toHaveBeenLastCalledWith(224)
    expect(document.querySelector('[data-visual-state="idle"]')).toBeInTheDocument()
    fireEvent.pointerUp(character, {
      button: 0,
      pointerId: 7,
      screenX: 232,
      screenY: 181,
    })

    await waitFor(() => {
      expect(nativeApi.begin_desktop_pet_drag).toHaveBeenCalledWith(200, 160)
      expect(nativeApi.move_desktop_pet_drag).toHaveBeenLastCalledWith(232, 181)
      expect(nativeApi.end_desktop_pet_drag).toHaveBeenCalledTimes(1)
    })
    expect(poseMocks.tap).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('桌宠悄悄话')).not.toBeInTheDocument()
    expect(character.closest('main')).not.toHaveClass('desktop-pet--dragging')
    expect(poseMocks.dragAt).toHaveBeenLastCalledWith(null)
  })

  it('retains the right-click menu and double-click main-window action', async () => {
    renderDesktopPet()
    const character = screen.getByRole('button', { name: /双击打开书斋/ })

    fireEvent.contextMenu(character)
    expect(screen.getByLabelText('桌宠菜单')).toBeInTheDocument()

    fireEvent.doubleClick(character)
    await waitFor(() => expect(nativeApi.show_main_window).toHaveBeenCalledWith('/gui'))
  })

  it.each(['character', 'menu', 'setting', 'background'] as const)(
    'toggles the menu closed with a second right-click on %s, then opens it again',
    async (targetName) => {
      renderDesktopPet()
      await act(async () => {})
      const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
      const rightClick = async (target: Element) => {
        await act(async () => {
          fireEvent.pointerDown(target, { button: 2, buttons: 2, pointerId: 3 })
          fireEvent.pointerUp(target, { button: 2, buttons: 0, pointerId: 3 })
          expect(fireEvent.contextMenu(target, { button: 2 })).toBe(false)
        })
      }

      await rightClick(character)
      const menu = screen.getByLabelText('桌宠菜单')
      const target = targetName === 'menu' ? menu.querySelector('strong')!
        : targetName === 'setting' ? screen.getByLabelText('桌宠大小')
          : targetName === 'background' ? screen.getByRole('main') : character
      const wakeCalls = nativeApi.cancel_desktop_pet_edge_move.mock.calls.length
      await rightClick(target)
      expect(screen.queryByLabelText('桌宠菜单')).not.toBeInTheDocument()
      expect(nativeApi.cancel_desktop_pet_edge_move).toHaveBeenCalledTimes(wakeCalls)
      expect(nativeApi.begin_desktop_pet_drag).not.toHaveBeenCalled()
      expect(poseMocks.tap).not.toHaveBeenCalled()
      expect(apiMocks.put).not.toHaveBeenCalled()
      expect(screen.queryByLabelText('桌宠悄悄话')).not.toBeInTheDocument()

      await rightClick(character)
      expect(screen.getByLabelText('桌宠菜单')).toBeInTheDocument()
    },
  )

  it('closes the menu on Escape and left-clicks outside it, but keeps menu controls usable', async () => {
    renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    fireEvent.keyDown(character, { key: 'Enter' })
    fireEvent.contextMenu(character)
    fireEvent.pointerDown(screen.getByLabelText('桌宠衣装'), { button: 0 })
    expect(screen.getByLabelText('桌宠菜单')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByLabelText('桌宠衣装'), { key: 'Escape' })
    expect(screen.queryByLabelText('桌宠菜单')).not.toBeInTheDocument()

    fireEvent.contextMenu(character)
    fireEvent.pointerDown(screen.getByLabelText('桌宠悄悄话').querySelector('p')!, { button: 0 })
    expect(screen.queryByLabelText('桌宠菜单')).not.toBeInTheDocument()
    fireEvent.contextMenu(character)
    fireEvent.pointerDown(screen.getByRole('main'), { button: 0 })
    expect(screen.queryByLabelText('桌宠菜单')).not.toBeInTheDocument()
    await act(async () => {})
  })

  it('coalesces slow native moves to the newest release position instead of replaying old frames', async () => {
    const pending = deferred<boolean>()
    nativeApi.move_desktop_pet_drag.mockImplementationOnce(() => pending.promise)
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id) }))
    const flushFrame = () => {
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach(callback => callback(100))
    }
    renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    fireEvent.pointerDown(character, { button: 0, pointerId: 91, screenX: 200, screenY: 160 })
    for (let i = 1; i <= 12; i++) {
      await act(async () => {
        fireEvent.pointerMove(character, { pointerId: 91, buttons: 1, screenX: 200 + i * 10, screenY: 160 })
        flushFrame()
      })
    }
    expect(nativeApi.move_desktop_pet_drag).toHaveBeenCalledTimes(1)
    fireEvent.pointerUp(character, { pointerId: 91, screenX: 335, screenY: 180 })
    expect(character.closest('main')).not.toHaveClass('desktop-pet--dragging')
    expect(nativeApi.end_desktop_pet_drag).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(true) })
    expect(nativeApi.move_desktop_pet_drag).toHaveBeenCalledTimes(2)
    expect(nativeApi.move_desktop_pet_drag).toHaveBeenLastCalledWith(335, 180)
    expect(nativeApi.end_desktop_pet_drag).toHaveBeenCalledTimes(1)
    expect(poseMocks.tap).not.toHaveBeenCalled()
  })

  it.each(['false', 'rejected'] as const)('cleans up a %s native move without pretending it reached the edge', async failure => {
    if (failure === 'false') nativeApi.move_desktop_pet_drag.mockResolvedValueOnce(false)
    else nativeApi.move_desktop_pet_drag.mockRejectedValueOnce(new Error('bridge failed'))
    nativeApi.get_desktop_pet_window_context.mockResolvedValue({
      ...(await nativeApi.get_desktop_pet_window_context()), x: 0,
    })
    renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    fireEvent.pointerDown(character, { button: 0, pointerId: 92, screenX: 100, screenY: 100 })
    fireEvent.pointerUp(character, { pointerId: 92, screenX: 130, screenY: 100 })
    await act(async () => {})
    expect(nativeApi.end_desktop_pet_drag).toHaveBeenCalledTimes(1)
    expect(nativeApi.move_desktop_pet_to_edge).not.toHaveBeenCalled()
  })

  it('finishes the previous native gesture before beginning a rapid second drag', async () => {
    const ending = deferred<boolean>()
    nativeApi.end_desktop_pet_drag.mockImplementationOnce(() => ending.promise)
    renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    fireEvent.pointerDown(character, { button: 0, pointerId: 93, screenX: 100, screenY: 100 })
    fireEvent.pointerUp(character, { pointerId: 93, screenX: 125, screenY: 100 })
    await act(async () => {})
    expect(nativeApi.end_desktop_pet_drag).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(character, { button: 0, pointerId: 94, screenX: 125, screenY: 100 })
    fireEvent.pointerMove(character, { pointerId: 94, buttons: 1, screenX: 155, screenY: 100 })
    await act(async () => {})
    expect(character.closest('main')).toHaveClass('desktop-pet--dragging')
    expect(nativeApi.begin_desktop_pet_drag).toHaveBeenCalledTimes(1)
    await act(async () => { ending.resolve(true) })
    expect(nativeApi.begin_desktop_pet_drag).toHaveBeenNthCalledWith(2, 125, 100)
    fireEvent.pointerUp(character, { pointerId: 94, screenX: 165, screenY: 100 })
    await act(async () => {})
    expect(nativeApi.move_desktop_pet_drag).toHaveBeenLastCalledWith(165, 100)
    expect(nativeApi.end_desktop_pet_drag).toHaveBeenCalledTimes(2)
    expect(poseMocks.tap).not.toHaveBeenCalled()
  })

  it('continues the active drag at window level after DOM capture is lost', async () => {
    renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    fireEvent.pointerDown(character, { button: 0, pointerId: 95, screenX: 100, screenY: 100 })
    fireEvent.lostPointerCapture(character, { pointerId: 95 })
    fireEvent.pointerMove(window, { pointerId: 95, buttons: 1, screenX: 140, screenY: 110 })
    expect(character.closest('main')).toHaveClass('desktop-pet--dragging')
    fireEvent.pointerUp(window, { pointerId: 95, screenX: 145, screenY: 112 })
    await act(async () => {})
    expect(nativeApi.move_desktop_pet_drag).toHaveBeenLastCalledWith(145, 112)
    expect(nativeApi.end_desktop_pet_drag).toHaveBeenCalledTimes(1)
    expect(character.closest('main')).not.toHaveClass('desktop-pet--dragging')
    expect(poseMocks.tap).not.toHaveBeenCalled()
  })

  it('ignores unrelated pointers, non-primary releases and moves with no pressed button', async () => {
    renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    fireEvent.pointerDown(character, { button: 0, pointerId: 97, screenX: 100, screenY: 100 })
    fireEvent.pointerMove(window, { pointerId: 98, buttons: 1, screenX: 400, screenY: 400 })
    fireEvent.pointerMove(window, { pointerId: 97, buttons: 0, screenX: -1, screenY: -1 })
    fireEvent.pointerUp(window, { pointerId: 98, screenX: 400, screenY: 400 })
    fireEvent.pointerUp(window, { pointerId: 97, button: 2, screenX: 100, screenY: 100 })
    await act(async () => {})
    expect(character.closest('main')).not.toHaveClass('desktop-pet--dragging')
    expect(nativeApi.end_desktop_pet_drag).not.toHaveBeenCalled()
    expect(poseMocks.dragAt).toHaveBeenCalledExactlyOnceWith(100)
    fireEvent.pointerMove(window, { pointerId: 97, buttons: 1, screenX: 140, screenY: 110 })
    expect(character.closest('main')).toHaveClass('desktop-pet--dragging')
    fireEvent.pointerUp(window, { pointerId: 97, button: 0, screenX: 145, screenY: 112 })
    await act(async () => {})
    expect(nativeApi.move_desktop_pet_drag).toHaveBeenCalledExactlyOnceWith(145, 112)
    expect(nativeApi.end_desktop_pet_drag).toHaveBeenCalledTimes(1)
    expect(poseMocks.tap).not.toHaveBeenCalled()
  })

  it('ignores the previous drop geometry when it arrives during a new drag', async () => {
    const context = await nativeApi.get_desktop_pet_window_context()
    const late = deferred<typeof context>()
    renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    nativeApi.get_desktop_pet_window_context.mockImplementationOnce(() => late.promise)
    fireEvent.pointerDown(character, { button: 0, pointerId: 99, screenX: 100, screenY: 100 })
    fireEvent.pointerUp(window, { pointerId: 99, screenX: 130, screenY: 100 })
    await act(async () => {})
    fireEvent.pointerDown(character, { button: 0, pointerId: 100, screenX: 130, screenY: 100 })
    fireEvent.pointerMove(window, { pointerId: 100, buttons: 1, screenX: 160, screenY: 100 })
    await act(async () => { late.resolve({ ...context, x: 1560 }) })
    expect(character.closest('main')).toHaveClass('desktop-pet--dragging', 'desktop-pet--bubble-right')
    expect(character.closest('main')).toHaveAttribute('data-desktop-pet-ambient', 'awake')
    expect(nativeApi.move_desktop_pet_to_edge).not.toHaveBeenCalled()
    fireEvent.pointerCancel(window, { pointerId: 100 })
    await act(async () => {})
  })

  it.each(['blur', 'hidden', 'unmount'] as const)('cancels the pending drag on %s without moving, tapping or docking', async reason => {
    const view = renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    fireEvent.pointerDown(character, { button: 0, pointerId: 96, screenX: 100, screenY: 100 })
    await act(async () => {})
    fireEvent.pointerMove(character, { pointerId: 96, buttons: 1, screenX: 140, screenY: 100 })
    expect(character.closest('main')).toHaveClass('desktop-pet--dragging')
    if (reason === 'blur') fireEvent.blur(window)
    else if (reason === 'unmount') view.unmount()
    else {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
      fireEvent(document, new Event('visibilitychange'))
    }
    await act(async () => {})
    expect(nativeApi.end_desktop_pet_drag).toHaveBeenCalledTimes(1)
    expect(nativeApi.move_desktop_pet_drag).not.toHaveBeenCalled()
    expect(nativeApi.move_desktop_pet_to_edge).not.toHaveBeenCalled()
    expect(poseMocks.tap).not.toHaveBeenCalled()
    if (reason !== 'unmount') expect(character.closest('main')).not.toHaveClass('desktop-pet--dragging')
    fireEvent.pointerUp(window, { pointerId: 96, screenX: 145, screenY: 100 })
    expect(screen.queryByLabelText('桌宠悄悄话')).not.toBeInTheDocument()
  })

  it('repositions the bubble directly without a character action sequence', async () => {
    nativeApi.get_desktop_pet_window_context.mockResolvedValue({
      x: 120,
      y: 200,
      width: 360,
      height: 520,
      work_x: 0,
      work_y: 0,
      work_width: 1920,
      work_height: 1040,
    })
    renderDesktopPet()
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    const pet = character.closest('main')
    await waitFor(() => expect(pet).toHaveClass('desktop-pet--bubble-right'))

    nativeApi.get_desktop_pet_window_context.mockResolvedValue({
      x: 1500,
      y: 200,
      width: 360,
      height: 520,
      work_x: 0,
      work_y: 0,
      work_width: 1920,
      work_height: 1040,
    })
    fireEvent.pointerDown(character, {
      button: 0,
      pointerId: 12,
      screenX: 400,
      screenY: 260,
    })
    fireEvent.pointerMove(character, {
      pointerId: 12,
      buttons: 1,
      screenX: 430,
      screenY: 270,
      clientX: 170,
      clientY: 220,
    })
    fireEvent.pointerUp(character, {
      button: 0,
      pointerId: 12,
      screenX: 435,
      screenY: 272,
    })

    await waitFor(() => expect(pet).toHaveClass('desktop-pet--bubble-left'))
    expect(pet).not.toHaveAttribute('data-desktop-pet-bubble-motion')
    expect(document.querySelector('[data-visual-state="idle"]')).toBeInTheDocument()
  })

  it('peeks after a right-edge drop and comes out on click, with the bubble toward free space', async () => {
    operationMocks.isError = true
    nativeApi.get_desktop_pet_window_context.mockResolvedValue({
      x: 1560,
      y: 200,
      width: 360,
      height: 520,
      work_x: 0,
      work_y: 0,
      work_width: 1920,
      work_height: 1040,
    })
    renderDesktopPet()
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    const pet = character.closest('main')

    await waitFor(() => expect(pet).toHaveClass('desktop-pet--bubble-left'))
    fireEvent.pointerDown(character, {
      button: 0,
      pointerId: 9,
      screenX: 1700,
      screenY: 300,
    })
    fireEvent.pointerMove(character, {
      pointerId: 9,
      buttons: 1,
      screenX: 1725,
      screenY: 312,
      clientX: 260,
      clientY: 270,
    })
    fireEvent.pointerUp(character, {
      button: 0,
      pointerId: 9,
      screenX: 1730,
      screenY: 315,
    })

    await waitFor(() => expect(nativeApi.end_desktop_pet_drag).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'peek-right'))
    expect(pet).toHaveClass('desktop-pet--bubble-left')
    expect(pet).toHaveClass('desktop-pet--peek-right')
    expect(nativeApi.move_desktop_pet_to_edge).toHaveBeenCalledWith('right', expect.objectContaining({ width: expect.any(Number) }))
    expect(pet).not.toHaveAttribute('data-desktop-pet-bubble-motion')
    await act(async () => {
      fireEvent.pointerDown(character, { button: 0, pointerId: 10, screenX: 1700, screenY: 300 })
      fireEvent.pointerUp(character, { button: 0, pointerId: 10, screenX: 1700, screenY: 300 })
    })
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'awake')
    expect(nativeApi.cancel_desktop_pet_edge_move).toHaveBeenCalled()
  })

  it('does not doze during a long drag and starts a fresh idle period on release', async () => {
    vi.useFakeTimers()
    renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    const pet = character.closest('main')
    fireEvent.pointerDown(character, { button: 0, pointerId: 15, screenX: 100, screenY: 100 })
    fireEvent.pointerMove(character, { pointerId: 15, buttons: 1, screenX: 120, screenY: 120 })
    await act(async () => { vi.advanceTimersByTime(10 * 60_000) })
    expect(pet).toHaveClass('desktop-pet--dragging')
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'awake')
    fireEvent.pointerUp(character, { button: 0, pointerId: 15, screenX: 120, screenY: 120 })
    await act(async () => { vi.advanceTimersByTime(9 * 60_000) })
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'awake')
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'sleeping')
  })

  it('can doze after long idle and wakes on pointer input or a new task', async () => {
    vi.useFakeTimers()
    const view = renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    const pet = character.closest('main')
    await act(async () => { vi.advanceTimersByTime(10 * 60_000) })
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'sleeping')
    expect(document.querySelector('[data-visual-state="sleeping"]')).toBeInTheDocument()
    expect(pet).not.toHaveClass('desktop-pet--sleep-book', 'desktop-pet--sleep-bubble')
    fireEvent.pointerEnter(character)
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'awake')
    await act(async () => { vi.advanceTimersByTime(10 * 60_000) })
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'sleeping')
    operationMocks.data = [{ id: 'new-task', status: 'queued', updated_at: new Date().toISOString() }]
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => { view.rerender(<QueryClientProvider client={client}><DesktopPetApp /></QueryClientProvider>) })
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'awake')
    expect(document.querySelector('[data-visual-state="thinking"]')).toBeInTheDocument()
  })

  it.each([['left', 0.6], ['right', 0.9]] as const)('travels to the %s edge after idle without waking just from hover', async (side, random) => {
    vi.useFakeTimers()
    vi.mocked(Math.random).mockReturnValue(random)
    renderDesktopPet()
    await act(async () => {})
    await act(async () => { vi.advanceTimersByTime(10 * 60_000) })
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    const pet = character.closest('main')
    expect(nativeApi.move_desktop_pet_to_edge).toHaveBeenCalledWith(side, expect.objectContaining({ width: expect.any(Number) }))
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', `peek-${side}`)
    expect(pet).toHaveClass(`desktop-pet--bubble-${side === 'left' ? 'right' : 'left'}`)
    expect(screen.queryByLabelText('桌宠悄悄话')).not.toBeInTheDocument()
    fireEvent.pointerEnter(character)
    fireEvent.pointerMove(character, { clientX: 20, clientY: 70 })
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', `peek-${side}`)
    await act(async () => { fireEvent.keyDown(character, { key: 'Enter' }) })
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'awake')
  })

  it('ignores a late edge response after pointer interaction cancelled the travel', async () => {
    vi.useFakeTimers()
    vi.mocked(Math.random).mockReturnValue(0.6)
    let finish: ((context: Awaited<ReturnType<typeof nativeApi.get_desktop_pet_window_context>>) => void) | undefined
    nativeApi.move_desktop_pet_to_edge.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    renderDesktopPet()
    await act(async () => {})
    await act(async () => { vi.advanceTimersByTime(10 * 60_000) })
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    expect(character.closest('main')).toHaveAttribute('data-desktop-pet-ambient', 'going-left')
    fireEvent.pointerDown(character, { button: 0, pointerId: 31, screenX: 100, screenY: 100 })
    await act(async () => { finish?.({ ...(await nativeApi.get_desktop_pet_window_context()), x: 0 }) })
    expect(character.closest('main')).toHaveAttribute('data-desktop-pet-ambient', 'awake')
    expect(character.closest('main')).not.toHaveClass('desktop-pet--peek-left')
  })

  it('does not hide the model when native docking fails', async () => {
    vi.useFakeTimers()
    vi.mocked(Math.random).mockReturnValue(0.9)
    nativeApi.move_desktop_pet_to_edge.mockResolvedValue(null)
    renderDesktopPet()
    await act(async () => {})
    await act(async () => { vi.advanceTimersByTime(10 * 60_000) })
    const pet = screen.getByRole('button', { name: /拖动可移动桌宠/ }).closest('main')
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'awake')
    expect(nativeApi.move_desktop_pet_to_edge).toHaveBeenCalledTimes(1)
  })

  it.each(['pending', 'docked'] as const)('a new task cancels %s edge activity without losing the task state', async (phase) => {
    vi.useFakeTimers()
    vi.mocked(Math.random).mockReturnValue(0.6)
    let finish: ((context: Awaited<ReturnType<typeof nativeApi.get_desktop_pet_window_context>>) => void) | undefined
    if (phase === 'pending') {
      nativeApi.move_desktop_pet_to_edge.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    }
    const view = renderDesktopPet()
    await act(async () => {})
    await act(async () => { vi.advanceTimersByTime(10 * 60_000) })
    const pet = screen.getByRole('button', { name: /拖动可移动桌宠/ }).closest('main')
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', phase === 'pending' ? 'going-left' : 'peek-left')
    const cancelCount = nativeApi.cancel_desktop_pet_edge_move.mock.calls.length
    operationMocks.data = [{ id: 'edge-new-task', status: 'queued', updated_at: new Date().toISOString() }]
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    view.rerender(<QueryClientProvider client={client}><DesktopPetApp /></QueryClientProvider>)
    await act(async () => { finish?.({ ...(await nativeApi.get_desktop_pet_window_context()), x: 0 }) })
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'awake')
    expect(pet).toHaveAttribute('data-desktop-pet-state', 'thinking')
    expect(nativeApi.cancel_desktop_pet_edge_move.mock.calls.length).toBeGreaterThan(cancelCount)
    expect(screen.queryByLabelText('桌宠悄悄话')).not.toBeInTheDocument()
  })

  it.each(['left', 'right'] as const)('retains the %s viewport after native acknowledgement until the canvas confirms restoration', async side => {
    const view = renderDesktopPet()
    await act(async () => {})
    fireEvent.contextMenu(screen.getByRole('button', { name: /拖动可移动桌宠/ }))
    fireEvent.change(screen.getByLabelText('桌宠小动作'), { target: { value: `peek-${side}` } })
    await act(async () => {})
    const nativeRestore = deferred<boolean>()
    nativeApi.cancel_desktop_pet_edge_move.mockReturnValueOnce(nativeRestore.promise)
    operationMocks.data = [{ id: 'viewport-task', status: 'queued', updated_at: new Date().toISOString() }]
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    view.rerender(<QueryClientProvider client={client}><DesktopPetApp /></QueryClientProvider>)
    await act(async () => {})
    let rendered = poseMocks.render.mock.lastCall![0]
    const beforeAck = rendered.peekLayout
    expect(beforeAck).toEqual(expect.objectContaining({ side, nativeRestored: false }))
    expect(rendered.state).toBe('thinking')
    await act(async () => nativeRestore.resolve(true))
    rendered = poseMocks.render.mock.lastCall![0]
    const acknowledged = rendered.peekLayout
    expect(acknowledged).toEqual(expect.objectContaining({ side, nativeRestored: true }))
    // A frame measured before the bridge reply must not clear the newer state.
    act(() => rendered.onPeekRestored(beforeAck))
    expect(poseMocks.render.mock.lastCall![0].peekLayout).toBe(acknowledged)
    act(() => rendered.onPeekRestored(acknowledged))
    expect(poseMocks.render.mock.lastCall![0].peekLayout).toBeNull()
    expect(document.querySelector('main')).toHaveAttribute('data-desktop-pet-state', 'thinking')
    expect(apiMocks.put).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('桌宠悄悄话')).not.toBeInTheDocument()
  })

  it('uses the expanded dimensions when another dock starts before the previous resize is painted', async () => {
    let width = 272, height = 240
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, width, height))
    renderDesktopPet()
    await act(async () => {})
    const choose = async (side: 'left' | 'right') => {
      fireEvent.contextMenu(screen.getByRole('button', { name: /拖动可移动桌宠/ }))
      fireEvent.change(screen.getByLabelText('桌宠小动作'), { target: { value: `peek-${side}` } })
      await act(async () => {})
    }
    await choose('left')
    const first = poseMocks.render.mock.lastCall![0].peekLayout
    width = first.width; height = first.height
    await choose('right')
    const next = poseMocks.render.mock.lastCall![0]
    expect(next.peekLayout).toEqual(expect.objectContaining({ side: 'right', normalWidth: 272, normalHeight: 240 }))
    expect(nativeApi.move_desktop_pet_to_edge).toHaveBeenLastCalledWith('right', expect.objectContaining({
      viewport_width: 272, viewport_height: 240,
    }))
    act(() => next.onPeekRestored(first))
    expect(poseMocks.render.mock.lastCall![0].peekLayout).toBe(next.peekLayout)
  })

  it.each(['false', 'rejected'])('keeps compact geometry and allows retry after a %s restoration', async failure => {
    const view = renderDesktopPet()
    await act(async () => {})
    fireEvent.contextMenu(screen.getByRole('button', { name: /拖动可移动桌宠/ }))
    fireEvent.change(screen.getByLabelText('桌宠小动作'), { target: { value: 'peek-left' } })
    await act(async () => {})
    if (failure === 'false') nativeApi.cancel_desktop_pet_edge_move.mockResolvedValue(false)
    else nativeApi.cancel_desktop_pet_edge_move.mockRejectedValue(new Error('native restore failed'))
    operationMocks.data = [{ id: 'restore-failure-task', status: 'running', updated_at: new Date().toISOString() }]
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    view.rerender(<QueryClientProvider client={client}><DesktopPetApp /></QueryClientProvider>)
    await act(async () => {})
    expect(poseMocks.render.mock.lastCall![0].peekLayout).toEqual(expect.objectContaining({ nativeRestored: false }))
    expect(document.querySelector('main')).toHaveAttribute('data-desktop-pet-state', 'writing')
    nativeApi.cancel_desktop_pet_edge_move.mockResolvedValue(true)
    fireEvent.keyDown(screen.getByRole('button', { name: /拖动可移动桌宠/ }), { key: 'Enter' })
    await act(async () => {})
    const rendered = poseMocks.render.mock.lastCall![0]
    expect(rendered.peekLayout).toEqual(expect.objectContaining({ nativeRestored: true }))
    act(() => rendered.onPeekRestored(rendered.peekLayout))
    expect(poseMocks.render.mock.lastCall![0].peekLayout).toBeNull()
    expect(document.querySelector('main')).toHaveAttribute('data-desktop-pet-state', 'writing')
  })

  it('restores the whole model when the monitor edge no longer matches the window', async () => {
    vi.useFakeTimers()
    vi.mocked(Math.random).mockReturnValue(0.6)
    renderDesktopPet()
    await act(async () => {})
    await act(async () => { vi.advanceTimersByTime(10 * 60_000) })
    const pet = screen.getByRole('button', { name: /拖动可移动桌宠/ }).closest('main')
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'peek-left')
    nativeApi.get_desktop_pet_window_context.mockResolvedValue({
      ...(await nativeApi.get_desktop_pet_window_context()), x: 180,
    })
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'awake')
    expect(pet).not.toHaveClass('desktop-pet--peek-left')
  })

  it('does not dock after a cancelled drag near the left edge', async () => {
    nativeApi.get_desktop_pet_window_context.mockResolvedValue({
      ...(await nativeApi.get_desktop_pet_window_context()), x: 0,
    })
    renderDesktopPet()
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    fireEvent.pointerDown(character, { button: 0, pointerId: 44, screenX: 80, screenY: 200 })
    await act(async () => {})
    fireEvent.pointerMove(character, { pointerId: 44, buttons: 1, screenX: 50, screenY: 200 })
    fireEvent.pointerCancel(character, { button: 0, pointerId: 44, screenX: 40, screenY: 200 })
    expect(poseMocks.dragAt).toHaveBeenLastCalledWith(null)
    await waitFor(() => expect(nativeApi.end_desktop_pet_drag).toHaveBeenCalledTimes(1))
    expect(character.closest('main')).toHaveAttribute('data-desktop-pet-ambient', 'awake')
    expect(nativeApi.move_desktop_pet_to_edge).not.toHaveBeenCalled()
    expect(nativeApi.move_desktop_pet_drag).not.toHaveBeenCalled()
    expect(poseMocks.resetLook).toHaveBeenCalled()
  })

  it('offers reading without manufacturing an operation and wakes on a tap', async () => {
    renderDesktopPet()
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    await act(async () => {})
    fireEvent.contextMenu(character)
    fireEvent.change(screen.getByLabelText('桌宠小动作'), { target: { value: 'reading' } })
    expect(character.closest('main')).toHaveAttribute('data-desktop-pet-ambient', 'reading')
    expect(character.closest('main')).toHaveAttribute('data-desktop-pet-state', 'idle')
    expect(screen.queryByLabelText('桌宠悄悄话')).not.toBeInTheDocument()
    expect(apiMocks.put).not.toHaveBeenCalled()
    await act(async () => { fireEvent.keyDown(character, { key: 'Enter' }) })
    expect(character.closest('main')).toHaveAttribute('data-desktop-pet-ambient', 'awake')
  })

  it('keeps casual bubbles to the message and moves usage hints into the menu', async () => {
    renderDesktopPet()
    await act(async () => {})
    fireEvent.keyDown(screen.getByRole('button', { name: /拖动可移动桌宠/ }), { key: 'Enter' })
    const speech = screen.getByLabelText('桌宠悄悄话')
    expect(speech.querySelector('h1')).toBeNull()
    expect(speech).not.toHaveTextContent('双击回书斋')
    await act(async () => { fireEvent.contextMenu(screen.getByRole('button', { name: /拖动可移动桌宠/ })) })
    expect(screen.getByLabelText('桌宠菜单')).toHaveTextContent('双击回书斋')
  })

  it('shows speech only on a tap, fades after five seconds, and removes it from the DOM', async () => {
    vi.useFakeTimers()
    renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /单击换一句悄悄话/ })
    fireEvent.pointerEnter(character)
    fireEvent.pointerMove(character, { clientX: 80, clientY: 120 })
    expect(screen.queryByLabelText('桌宠悄悄话')).not.toBeInTheDocument()
    fireEvent.keyDown(character, { key: 'Enter' })
    expect(screen.getByLabelText('桌宠悄悄话')).toHaveAttribute('data-speech-phase', 'visible')
    await act(async () => { vi.advanceTimersByTime(PET_SPEECH_VISIBLE_MS - 1) })
    expect(screen.getByLabelText('桌宠悄悄话')).toHaveAttribute('data-speech-phase', 'visible')
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(screen.getByLabelText('桌宠悄悄话')).toHaveAttribute('data-speech-phase', 'fading')
    await act(async () => { vi.advanceTimersByTime(PET_SPEECH_FADE_MS) })
    expect(screen.queryByLabelText('桌宠悄悄话')).not.toBeInTheDocument()
  })

  it.each([4_000, PET_SPEECH_VISIBLE_MS + 50])('another tap at %s ms changes the line and restarts the full lifetime', async (delay) => {
    vi.useFakeTimers()
    renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /单击换一句悄悄话/ })
    fireEvent.keyDown(character, { key: 'Enter' })
    expect(screen.getByLabelText('桌宠悄悄话')).toHaveTextContent('小书抱好啦')
    await act(async () => { vi.advanceTimersByTime(delay) })
    fireEvent.keyDown(character, { key: ' ' })
    expect(screen.getByLabelText('桌宠悄悄话')).toHaveTextContent('写一点点')
    await act(async () => { vi.advanceTimersByTime(PET_SPEECH_VISIBLE_MS - 1) })
    expect(screen.getByLabelText('桌宠悄悄话')).toHaveAttribute('data-speech-phase', 'visible')
    await act(async () => { vi.advanceTimersByTime(1 + PET_SPEECH_FADE_MS) })
    expect(screen.queryByLabelText('桌宠悄悄话')).not.toBeInTheDocument()
    await act(async () => { fireEvent.keyDown(character, { key: 'Enter' }) })
    expect(screen.getByLabelText('桌宠悄悄话')).toHaveTextContent('我会乖乖待在这里')
  })

  it('does not reveal speech on a cancelled press or right-click', async () => {
    renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    await act(async () => {
      fireEvent.pointerDown(character, { button: 0, pointerId: 82, screenX: 100, screenY: 100 })
      fireEvent.pointerCancel(character, { button: 0, pointerId: 82, screenX: 100, screenY: 100 })
      fireEvent.contextMenu(character)
    })
    expect(screen.getByLabelText('桌宠菜单')).toBeInTheDocument()
    expect(screen.queryByLabelText('桌宠悄悄话')).not.toBeInTheDocument()
  })

  it('keeps task and disconnected bubbles tap-only too', async () => {
    vi.useFakeTimers()
    operationMocks.data = [{ id: 'real-task', status: 'running', updated_at: new Date().toISOString() }]
    operationMocks.isError = true
    renderDesktopPet()
    await act(async () => {})
    expect(screen.queryByLabelText('桌宠悄悄话')).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('button', { name: /单击换一句悄悄话/ }), { key: 'Enter' })
    expect(screen.getByLabelText('桌宠悄悄话').querySelector('h1')).toHaveTextContent('正在找回书页')
    await act(async () => { vi.advanceTimersByTime(PET_SPEECH_VISIBLE_MS + PET_SPEECH_FADE_MS) })
    expect(screen.queryByLabelText('桌宠悄悄话')).not.toBeInTheDocument()
  })

  it('cancels speech timers when the pet unmounts', () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(useDesktopPetSpeech)
    act(() => result.current.reveal())
    expect(vi.getTimerCount()).toBe(2)
    act(() => result.current.reveal())
    expect(vi.getTimerCount()).toBe(2)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disables casual pose overrides while a real operation is active', async () => {
    operationMocks.data = [{ id: 'real-task', status: 'running', updated_at: new Date().toISOString() }]
    renderDesktopPet()
    await act(async () => {})
    await act(async () => { fireEvent.contextMenu(screen.getByRole('button', { name: /拖动可移动桌宠/ })) })
    expect(screen.getByLabelText('桌宠小动作')).toBeDisabled()
    expect(document.querySelector('[data-visual-state="writing"]')).toBeInTheDocument()
  })

  it('does not immediately wake manual sleep when the menu disappears under the pointer', async () => {
    renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    fireEvent.contextMenu(character)
    fireEvent.change(screen.getByLabelText('桌宠小动作'), { target: { value: 'sleeping' } })
    fireEvent.pointerEnter(character)
    fireEvent.pointerMove(character, { clientX: 80, clientY: 120 })
    expect(character.closest('main')).toHaveAttribute('data-desktop-pet-state', 'sleeping')
    fireEvent.pointerLeave(character)
    fireEvent.pointerEnter(character)
    expect(character.closest('main')).toHaveAttribute('data-desktop-pet-state', 'idle')
  })

  it.each(['left', 'right'] as const)('manual %s peek uses native docking, not just CSS clipping', async (side) => {
    renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    fireEvent.contextMenu(character)
    fireEvent.change(screen.getByLabelText('桌宠小动作'), { target: { value: `peek-${side}` } })
    await waitFor(() => expect(character.closest('main')).toHaveAttribute('data-desktop-pet-ambient', `peek-${side}`))
    expect(nativeApi.move_desktop_pet_to_edge).toHaveBeenCalledWith(side, expect.objectContaining({ width: expect.any(Number) }))
  })

  it('keeps peeking on compact resize and wakes when settings restore the full window', async () => {
    renderDesktopPet()
    await act(async () => {})
    const character = screen.getByRole('button', { name: /拖动可移动桌宠/ })
    const pet = character.closest('main')
    fireEvent.contextMenu(character)
    fireEvent.change(screen.getByLabelText('桌宠小动作'), { target: { value: 'peek-left' } })
    await waitFor(() => expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'peek-left'))
    const compact = { ...(await nativeApi.get_desktop_pet_window_context()), compact: true }
    nativeApi.get_desktop_pet_window_context.mockResolvedValue(compact)
    await act(async () => { fireEvent(window, new Event('resize')) })
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'peek-left')
    expect(pet).toHaveAttribute('data-desktop-pet-bubble-placement', 'side')
    const restored = { ...compact, compact: false }
    nativeApi.get_desktop_pet_window_context.mockResolvedValue(restored)
    await act(async () => { fireEvent(window, new Event('resize')) })
    expect(pet).toHaveAttribute('data-desktop-pet-ambient', 'awake')
    const rendered = poseMocks.render.mock.lastCall![0]
    expect(rendered.peekLayout).toEqual(expect.objectContaining({ nativeRestored: true }))
    act(() => rendered.onPeekRestored(rendered.peekLayout))
    expect(pet?.style.getPropertyValue('--pet-peek-bubble-width')).toBe('')
  })

})
