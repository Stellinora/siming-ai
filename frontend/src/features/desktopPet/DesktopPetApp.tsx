import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { OperationRun } from '../../shared/api/contracts'
import {
  operationKeys,
  updateOperationInCache,
  useOperations,
} from '../operations'
import {
  DESKTOP_PET_LONG_IDLE_MS,
  desktopPetToneForState,
  deriveDesktopPetPresentation,
  type DesktopPetPresentation,
  type DesktopPetVisualState,
} from './state'
import {
  applyDesktopPetAmbientPresentation,
  desktopPetBubblePlacement,
  desktopPetBubbleSide,
  desktopPetEdgeSide,
  desktopPetIdleChoice,
  desktopPetPeekSide,
  desktopPetResizeAnchor,
  type DesktopPetAmbientMode,
  type DesktopPetBubblePlacement,
  type DesktopPetSide,
  type DesktopPetWindowContext,
} from './behavior'
import {
  cancelDesktopPetEdgeMove,
  getDesktopPetWindowContext,
  hideDesktopPet,
  moveDesktopPetToEdge,
  showMainWindow,
} from './nativeBridge'
import { NativePetDragController, type NativePetDragSession } from './nativeDrag'
import {
  PoseCanvas,
  type PoseCanvasHandle,
  type PetLoadStatus,
} from './poses/PoseCanvas'
import { compactPeekLayout, normalPeekViewport, PEEK_BUBBLE_MAX_HEIGHT, type PeekViewport } from './poses/placement'
import { isOutfitId, manifest } from './poses/contract'
import { useDesktopPetHitRegion } from './useDesktopPetHitRegion'
import { PET_SPEECH_FADE_MS, useDesktopPetSpeech } from './useDesktopPetSpeech'
import { useDesktopPetSettings } from './useDesktopPetSettings'
import { PetSettingsSlider } from './PetSettingsSlider'
import './DesktopPetApp.css'

const IDLE_CLOCK_TICK_MS = 15_000
const DRAG_THRESHOLD_PX = 6
interface DesktopPetDragSession {
  pointerId: number
  startScreenX: number
  startScreenY: number
  latestScreenX: number
  latestScreenY: number
  moved: boolean
  moveFrame: number | null
  target: HTMLButtonElement
  native: NativePetDragSession
}

function releaseDragCapture(session: DesktopPetDragSession) {
  if (session.moveFrame !== null) {
    window.cancelAnimationFrame(session.moveFrame)
    session.moveFrame = null
  }
  try {
    session.target.releasePointerCapture(session.pointerId)
  } catch {
    // WebView2 may have already lost DOM capture when the native window moved.
  }
}

type DesktopPetChatterKey = DesktopPetVisualState | 'paused' | 'peeking' | 'reading'

const PET_CHATTER: Record<DesktopPetChatterKey, readonly string[]> = {
  reading: [
    '这一页好有趣，想和你一起看 (｡･ω･｡)ﾉ♡',
    '小书摊开啦，陪你安静读一会儿～',
    '发现一个好句子，先偷偷记下来 φ(•ᴗ•๑)',
  ],
  peeking: [
    '我躲好啦～找到我了吗？|ω･)',
    '只露一点点，偷偷陪你 ♡',
    '嘘，在悄悄观察！|ω•́)✧',
    '被发现啦！戳戳就出来 (˶ᵔ ᵕ ᵔ˶)',
  ],
  idle: [
    '小书抱好啦，今天也陪你慢慢写～(｡•ᴗ•｡)',
    '写一点点，也是在往前走呀 (•̀ᴗ•́)و',
    '我会乖乖待在这里，不催你～(˶ᵔ ᵕ ᵔ˶)',
    '卡住就戳戳我，我们一起想 ( •̀ ω •́ )✧',
  ],
  thinking: [
    '嗯……让我翻翻小本本 ( ˘•ω•˘ )',
    '线索一根根排好，很快就清楚啦～',
    '脑袋转转……再给我一小会儿 (｡•̀ᴗ-)✧',
    '快想到了，再等我一下下～(•̀ᴗ•́)و',
  ],
  writing: [
    '沙沙沙……这一页正在长出来 φ(•ᴗ•๑)',
    '墨还热乎乎的，再等我一下下～',
    '陪你认真写这一页 (๑•̀ㅂ•́)و✧',
    '这一笔写稳，再接着写下一笔～',
  ],
  waiting_author: [
    '稿稿抱好啦，就等你点头～(｡•̀ᴗ-)✧',
    '这一页想听听你的意见呀 (´｡• ᵕ •｡`)',
    '我先不乱动，乖乖等你定稿～',
    '你说可以，我就继续往下写 (•̀ᴗ•́)و',
  ],
  paused: [
    '书签夹好啦，想继续时再叫我～(｡•ᴗ•｡)',
    '我替你压住书页，不会弄乱的。',
    '先歇一会儿吧，我在这里等你 (˶ᵔ ᵕ ᵔ˶)',
    '放心去忙，回来还是这一页～',
  ],
  completed: [
    '锵锵，这一页写好啦！ヽ(✿ﾟ▽ﾟ)ノ',
    '小书页完成，快来摸摸头～(≧▽≦)',
    '墨笔收好啦，等你来验收 (๑˃ᴗ˂)و',
    '又陪你往前走了一小步，嘿嘿～',
  ],
  error: [
    '呜……书页打了个小结 (｡•́︿•̀｡)',
    '别担心，我们一起把结解开 (•̀ᴗ•́)و',
    '我先抱住问题，不让它偷偷跑掉。',
    '好像有哪里不对，陪我看一眼嘛～',
  ],
  sleeping: [
    '呼……眯一小会儿……(_ _).｡o○',
    '我只眯一小会儿，有事轻轻戳我～',
    '梦里也替你守着书页呢 (´꒳`)♡',
    '唔……再睡五个字就起来……zzZ',
  ],
}

function chatterForPresentation(presentation: DesktopPetPresentation, ambient: DesktopPetAmbientMode) {
  const key = !presentation.operation && ambient === 'reading' ? 'reading'
    : !presentation.operation && desktopPetPeekSide(ambient) ? 'peeking' : presentation.operation?.status === 'paused'
    ? 'paused'
    : presentation.state
  const casual = PET_CHATTER[key]
  const taskDetail = presentation.operation
    && presentation.state !== 'idle'
    && presentation.state !== 'sleeping'
    ? presentation.detail.trim()
    : ''
  return taskDetail && !casual.includes(taskDetail)
    ? [taskDetail, ...casual]
    : [...casual]
}

type DesktopPetSound =
  | 'completed'
  | 'error'
  | 'tap'
  | 'pickup'

interface DesktopPetSoundNote {
  frequency: number
  endFrequency?: number
  delay?: number
  duration: number
  volume: number
  wave?: OscillatorType
}

const PET_SOUND_NOTES: Record<DesktopPetSound, readonly DesktopPetSoundNote[]> = {
  completed: [
    { frequency: 523.25, duration: 0.18, volume: 0.038 },
    { frequency: 659.25, delay: 0.11, duration: 0.2, volume: 0.035 },
  ],
  error: [
    { frequency: 220, endFrequency: 174.61, duration: 0.26, volume: 0.032, wave: 'triangle' },
  ],
  tap: [
    { frequency: 740, endFrequency: 980, duration: 0.09, volume: 0.022 },
    { frequency: 1046.5, delay: 0.07, duration: 0.07, volume: 0.016 },
  ],
  pickup: [
    { frequency: 260, endFrequency: 410, duration: 0.16, volume: 0.027, wave: 'triangle' },
  ],

}

let petAudioContext: AudioContext | null = null
let petAudioUnlocked = false

function getPetAudioContext() {
  const AudioContextType = window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextType) return null
  try {
    if (!petAudioContext || petAudioContext.state === 'closed') {
      petAudioContext = new AudioContextType()
      petAudioUnlocked = petAudioContext.state === 'running'
    }
    return petAudioContext
  } catch {
    return null
  }
}

function primePetAudio() {
  const context = getPetAudioContext()
  if (!context) return
  if (context.state === 'running') {
    petAudioUnlocked = true
    return
  }
  if (context.state === 'suspended') {
    void context.resume().then(() => {
      petAudioUnlocked = context.state === 'running'
    }).catch(() => undefined)
  }
}

function schedulePetNote(context: AudioContext, note: DesktopPetSoundNote) {
  const startAt = context.currentTime + (note.delay || 0)
  const stopAt = startAt + note.duration
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = note.wave || 'sine'
  oscillator.frequency.setValueAtTime(note.frequency, startAt)
  if (note.endFrequency) {
    oscillator.frequency.exponentialRampToValueAtTime(note.endFrequency, stopAt)
  }
  gain.gain.setValueAtTime(0.0001, startAt)
  gain.gain.exponentialRampToValueAtTime(note.volume, startAt + Math.min(0.018, note.duration / 3))
  gain.gain.exponentialRampToValueAtTime(0.0001, stopAt)
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start(startAt)
  oscillator.stop(stopAt + 0.02)
}

function playPetSound(kind: DesktopPetSound) {
  const context = petAudioContext
  if (!context || context.state !== 'running' || !petAudioUnlocked) return
  try {
    PET_SOUND_NOTES[kind].forEach((note) => schedulePetNote(context, note))
  } catch {
    // WebView audio can be unavailable until a user gesture; visuals remain authoritative.
  }
}

export default function DesktopPetApp() {
  const queryClient = useQueryClient()
  const { data: operationItems, isError: operationsDisconnected, refetch } = useOperations(20)
  const operations = useMemo(() => operationItems || [], [operationItems])
  const [clock, setClock] = useState(() => Date.now())
  const basePresentation = useMemo(
    () => deriveDesktopPetPresentation(operations, clock),
    [clock, operations],
  )
  const activityKey = [
    operationsDisconnected ? 'disconnected' : 'connected',
    basePresentation.state,
    basePresentation.operation?.id || 'none',
  ].join(':')
  const [idleTracker, setIdleTracker] = useState(() => ({
    activityKey,
    idleSince: clock,
  }))
  const effectiveIdleSince = idleTracker.activityKey === activityKey
    ? idleTracker.idleSince
    : clock
  const [ambientMode, setAmbientMode] = useState<DesktopPetAmbientMode>('awake')
  const [bubbleSide, setBubbleSide] = useState<DesktopPetSide>('right')
  const [bubblePlacement, setBubblePlacement] = useState<DesktopPetBubblePlacement>('side')
  const [isDragging, setIsDragging] = useState(false)
  const [peekLayout, setPeekLayout] = useState<PeekViewport | null>(null)
  const pendingRestore = useRef<Promise<boolean>>(Promise.resolve(true))
  const windowContext = useRef<DesktopPetWindowContext | null>(null)
  const rootRef = useRef<HTMLElement>(null)
  const presentation = useMemo(
    () => applyDesktopPetAmbientPresentation(basePresentation, ambientMode),
    [ambientMode, basePresentation],
  )
  const [notice, setNotice] = useState('')
  const { settings, saving, previewSettings, persistSettings } = useDesktopPetSettings(setNotice)
  const previousOutfit = useRef(settings.desktop_pet_outfit)
  const mutedRef = useRef(settings.desktop_pet_muted)
  mutedRef.current = settings.desktop_pet_muted
  const [chatterIndex, setChatterIndex] = useState(-1)
  const speech = useDesktopPetSpeech()
  const [menuOpen, setMenuOpen] = useState(false)
  const updateCharacterRegion = useDesktopPetHitRegion(rootRef, setNotice)
  const [petStatus, setPetStatus] = useState<PetLoadStatus>('loading')
  const dragSession = useRef<DesktopPetDragSession | null>(null)
  const [nativeDrag] = useState(() => new NativePetDragController())
  const petRef = useRef<PoseCanvasHandle | null>(null)
  // Closing the action menu exposes the button under the pointer. This is not
  // a new hover gesture: keep manual sleep until the pointer leaves or clicks.
  const manualSleepHoverGuard = useRef(false)
  const edgeRequest = useRef(0)
  const previousState = useRef(presentation.state)
  const chatterLines = chatterForPresentation(presentation, ambientMode)
  const chatterLine = chatterLines[Math.max(0, chatterIndex) % chatterLines.length]

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), IDLE_CLOCK_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => setChatterIndex(-1), [activityKey, ambientMode])

  useEffect(() => {
    document.documentElement.classList.add('desktop-pet-document')
    document.body.classList.add('desktop-pet-document')
    return () => {
      document.documentElement.classList.remove('desktop-pet-document')
      document.body.classList.remove('desktop-pet-document')
    }
  }, [])

  const activeOperationId = useMemo(() => (
    presentation.operation
    && ['queued', 'running', 'waiting_user', 'paused'].includes(presentation.operation.status)
      ? presentation.operation.id
      : undefined
  ), [presentation.operation])

  useEffect(() => {
    if (!activeOperationId) return
    const source = new EventSource(`/api/v1/operations/${activeOperationId}/stream`)
    source.addEventListener('heartbeat', (event) => {
      try {
        const next = JSON.parse((event as MessageEvent).data) as OperationRun
        queryClient.setQueryData<OperationRun[]>(
          operationKeys.list(20),
          (current) => updateOperationInCache(current, next),
        )
      } catch {
        // The 3-second operation poll remains authoritative.
      }
    })
    source.addEventListener('done', () => {
      source.close()
      void refetch()
    })
    return () => source.close()
  }, [activeOperationId, queryClient, refetch])

  useEffect(() => {
    const previous = previousState.current
    previousState.current = presentation.state
    if (settings.desktop_pet_muted || previous === presentation.state) return
    const tone = desktopPetToneForState(presentation.state)
    if (tone) playPetSound(tone)
  }, [presentation.state, settings.desktop_pet_muted])

  useEffect(() => {
    const closeOverlays = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
      }
    }
    window.addEventListener('keydown', closeOverlays)
    return () => window.removeEventListener('keydown', closeOverlays)
  }, [])

  const openMain = useCallback(async (route = presentation.actionRoute) => {
    setMenuOpen(false)
    await showMainWindow(route)
  }, [presentation.actionRoute])

  const wakePet = useCallback(() => {
    manualSleepHoverGuard.current = false
    const request = ++edgeRequest.current
    setPeekLayout(current => current && { ...current, nativeRestored: false })
    pendingRestore.current = cancelDesktopPetEdgeMove().catch(() => false)
    void pendingRestore.current.then(restored => {
      if (request !== edgeRequest.current) return
      if (restored) setPeekLayout(current => current && { ...current, nativeRestored: true })
      else if (peekLayout) setNotice('窗口还没恢复好，轻点我再试一次～')
    })
    const now = Date.now()
    setClock(now)
    setIdleTracker({ activityKey, idleSince: now })
    setAmbientMode('awake')
  }, [activityKey, peekLayout])

  const acknowledgePeekRestore = useCallback((restored: PeekViewport) => {
    // A late frame from the previous exit cannot clear a new docking request.
    setPeekLayout(current => current === restored ? null : current)
  }, [])

  useEffect(() => {
    if (previousOutfit.current === settings.desktop_pet_outfit) return
    previousOutfit.current = settings.desktop_pet_outfit
    // A different outline must not inherit the old outfit's compact window.
    // Normal reading/sleep and real operations are otherwise unchanged.
    if (desktopPetPeekSide(ambientMode) || ambientMode === 'going-left' || ambientMode === 'going-right') wakePet()
  }, [ambientMode, settings.desktop_pet_outfit, wakePet])

  useEffect(() => {
    if (idleTracker.activityKey !== activityKey) wakePet()
  }, [activityKey, idleTracker.activityKey, wakePet])

  useEffect(() => () => {
    edgeRequest.current += 1
    void cancelDesktopPetEdgeMove().catch(() => undefined)
  }, [])

  const refreshWindowPlacement = useCallback(async () => {
    const request = edgeRequest.current
    const context: DesktopPetWindowContext = await getDesktopPetWindowContext()
    if (request !== edgeRequest.current) return context
    windowContext.current = context
    setBubbleSide(desktopPetBubbleSide(context))
    setBubblePlacement(context.compact ? 'side' : desktopPetBubblePlacement(context))
    return context
  }, [])

  const startPeek = useCallback(async (side: DesktopPetSide) => {
    const request = ++edgeRequest.current
    setAmbientMode(`going-${side}`)
    setMenuOpen(false)
    try {
      if (!await pendingRestore.current) throw new Error('窗口还没恢复好，轻点我再试一次～')
      if (request !== edgeRequest.current) return
      const viewport = rootRef.current?.getBoundingClientRect()
      // The bridge can finish before WebView2 has delivered its resize. A new
      // dock must use the original viewport, never compact an already small one.
      const normal = peekLayout && normalPeekViewport(peekLayout, settings.desktop_pet_scale)
      const layout: PeekViewport = {
        ...compactPeekLayout(normal?.width ?? (viewport?.width || window.innerWidth),
          normal?.height ?? (viewport?.height || window.innerHeight), settings.desktop_pet_outfit),
        side, scale: settings.desktop_pet_scale, nativeRestored: false,
      }
      setPeekLayout(layout)
      const context = await moveDesktopPetToEdge(side, layout)
      if (request !== edgeRequest.current) return
      const target = context && (side === 'left' ? context.work_x
        : context.work_x + context.work_width - context.width)
      if (!context || target === null || Math.abs(context.x - target) > 1) {
        throw new Error('没能走到屏幕边缘，我先在这里陪你～')
      }
      setBubbleSide(side === 'left' ? 'right' : 'left')
      setBubblePlacement('side')
      setAmbientMode(`peek-${side}`)
    } catch (error) {
      if (request !== edgeRequest.current) return
      wakePet()
      setNotice(error instanceof Error ? error.message : '贴边暂时不可用')
    }
  }, [peekLayout, settings.desktop_pet_outfit, settings.desktop_pet_scale, wakePet])

  useEffect(() => {
    const refresh = () => { void refreshWindowPlacement() }
    refresh()
    window.addEventListener('pywebviewready', refresh)
    return () => window.removeEventListener('pywebviewready', refresh)
  }, [refreshWindowPlacement])

  useEffect(() => {
    // Native compact / restore also emits resize. It must not cancel docking
    // or reset an in-progress pointer drag just because the window got smaller.
    const resize = () => {
      const request = edgeRequest.current
      void refreshWindowPlacement().then(context => {
        if (request === edgeRequest.current && desktopPetPeekSide(ambientMode) && context.compact === false) wakePet()
      })
    }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [ambientMode, refreshWindowPlacement, wakePet])

  useEffect(() => {
    const side = desktopPetPeekSide(ambientMode)
    if (!side) return undefined
    // Monitor/work-area changes must not leave a head clipped at an interior edge.
    const timer = window.setInterval(() => {
      const request = edgeRequest.current
      void getDesktopPetWindowContext().then((context) => {
        if (request !== edgeRequest.current) return
        const target = side === 'left' ? context.work_x : context.work_x + context.work_width - context.width
        if (context.compact === false || Math.abs(context.x - target) > 1) wakePet()
      })
    }, 2000)
    return () => window.clearInterval(timer)
  }, [ambientMode, wakePet])

  useEffect(() => {
    const idleEligible = (
      !operationsDisconnected
      && !basePresentation.operation
      && basePresentation.state === 'idle'
    )
    if (!idleEligible || ambientMode !== 'awake' || isDragging || menuOpen || petStatus !== 'ready') return undefined
    const remaining = Math.max(
      0,
      effectiveIdleSince + DESKTOP_PET_LONG_IDLE_MS - Date.now(),
    )
    const timer = window.setTimeout(() => {
      if (dragSession.current) return
      const choice = desktopPetIdleChoice()
      if (choice === 'sleeping') setAmbientMode('sleeping')
      else void startPeek(choice === 'peek-left' ? 'left' : 'right')
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [
    ambientMode,
    basePresentation.operation,
    basePresentation.state,
    effectiveIdleSince,
    operationsDisconnected,
    isDragging,
    menuOpen,
    petStatus,
    startPeek,
  ])

  const scheduleNativeDragMove = (session: DesktopPetDragSession) => {
    if (session.moveFrame !== null) return
    session.moveFrame = window.requestAnimationFrame(() => {
      session.moveFrame = null
      if (dragSession.current !== session || !session.moved) return
      session.native.move(session.latestScreenX, session.latestScreenY)
    })
  }

  const onCharacterPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || dragSession.current) return
    if (!mutedRef.current) primePetAudio()
    wakePet()
    const session: DesktopPetDragSession = {
      pointerId: event.pointerId,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      latestScreenX: event.screenX,
      latestScreenY: event.screenY,
      moved: false,
      moveFrame: null,
      target: event.currentTarget,
      native: nativeDrag.begin(event.screenX, event.screenY),
    }
    dragSession.current = session
    petRef.current?.dragAt(event.screenX)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Older WebView2 versions can omit pointer capture; window-relative drag still works.
    }
  }

  const finishCharacterPointer = (
    event: Pick<PointerEvent, 'pointerId' | 'screenX' | 'screenY'>,
    cancelled: boolean,
  ) => {
    const session = dragSession.current
    if (!session || session.pointerId !== event.pointerId) return
    if (!cancelled) {
      const distance = Math.hypot(
        event.screenX - session.startScreenX,
        event.screenY - session.startScreenY,
      )
      session.moved = session.moved || distance > DRAG_THRESHOLD_PX
      session.latestScreenX = event.screenX
      session.latestScreenY = event.screenY
    }
    dragSession.current = null
    petRef.current?.dragAt(null)
    if (cancelled) petRef.current?.resetLook()
    releaseDragCapture(session)
    if (session.moved && !cancelled) {
      session.native.move(session.latestScreenX, session.latestScreenY)
    }
    wakePet()
    setIsDragging(false)
    const nativeDragClosed = cancelled ? session.native.cancel() : session.native.finish()
    const releaseRequest = edgeRequest.current
    if (!cancelled && !session.moved) {
      petRef.current?.tap()
      if (!mutedRef.current) playPetSound('tap')
      setChatterIndex((current) => (current + 1) % chatterLines.length)
      speech.reveal()
      setMenuOpen(false)
    } else if (session.moved && !cancelled) {
      void nativeDragClosed.then(async (closed) => {
        if (!closed || dragSession.current || releaseRequest !== edgeRequest.current) return
        const context = await refreshWindowPlacement()
        if (dragSession.current || releaseRequest !== edgeRequest.current) return
        const side = desktopPetEdgeSide(context)
        if (side) await startPeek(side)
      })
    }
  }

  const cancelCharacterDrag = () => {
    const session = dragSession.current
    if (session) finishCharacterPointer({
      pointerId: session.pointerId, screenX: session.latestScreenX, screenY: session.latestScreenY,
    }, true)
    else petRef.current?.resetLook()
  }

  const onCharacterPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragSession.current) return
    if (presentation.state === 'sleeping' && !manualSleepHoverGuard.current) wakePet()
    petRef.current?.lookAt(event.clientX, event.clientY)
  }

  const moveCharacterDrag = (event: PointerEvent) => {
    const session = dragSession.current
    if (!session || session.pointerId !== event.pointerId || !(event.buttons & 1)) return
    petRef.current?.lookAt(event.clientX, event.clientY)
    session.latestScreenX = event.screenX
    session.latestScreenY = event.screenY
    const distance = Math.hypot(
      event.screenX - session.startScreenX,
      event.screenY - session.startScreenY,
    )
    if (!session.moved && distance > DRAG_THRESHOLD_PX) {
      session.moved = true
      if (!mutedRef.current) playPetSound('pickup')
      setIsDragging(true)
      setAmbientMode('awake')
      setMenuOpen(false)
    }
    if (session.moved) {
      event.preventDefault()
      petRef.current?.dragAt(event.screenX)
      scheduleNativeDragMove(session)
    }
  }

  const dragHandlers = useRef({ move: moveCharacterDrag, finish: finishCharacterPointer, cancel: cancelCharacterDrag })
  dragHandlers.current = { move: moveCharacterDrag, finish: finishCharacterPointer, cancel: cancelCharacterDrag }
  useEffect(() => {
    // Native SetBounds can drop DOM capture. WinForms continues forwarding OS
    // events, so the active gesture must accept moves/releases anywhere here.
    const move = (event: PointerEvent) => dragHandlers.current.move(event)
    const finish = (event: PointerEvent) => {
      if (event.type === 'pointerup' && event.button !== 0) return
      dragHandlers.current.finish(event, event.type === 'pointercancel')
    }
    const cancel = () => {
      dragHandlers.current.cancel()
      nativeDrag.cancelAll()
    }
    const visibility = () => { if (document.hidden) cancel() }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('pointercancel', finish, true)
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('pointercancel', finish, true)
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', visibility)
      const session = dragSession.current
      dragSession.current = null
      if (session) releaseDragCapture(session)
      nativeDrag.cancelAll()
    }
  }, [nativeDrag])

  const stateClass = `desktop-pet--${presentation.state}`
  const peekSide = desktopPetPeekSide(ambientMode)
  const rootStyle = {
    '--desktop-pet-opacity': settings.desktop_pet_opacity,
    '--pet-speech-fade-duration': `${PET_SPEECH_FADE_MS}ms`,
    ...(peekLayout ? {
      '--pet-peek-bubble-width': `${peekLayout.bubbleWidth}px`,
      '--pet-peek-bubble-top': `${peekLayout.bubbleTop}px`,
      '--pet-peek-bubble-inset': `${peekLayout.bubbleInset}px`,
      '--pet-peek-bubble-max-height': `${PEEK_BUBBLE_MAX_HEIGHT}px`,
    } : {}),
  } as React.CSSProperties
  const rootClasses = [
    'desktop-pet',
    stateClass,
    `desktop-pet--bubble-${bubbleSide}`,
    `desktop-pet--bubble-${bubblePlacement}`,
    isDragging ? 'desktop-pet--dragging' : '',
    peekSide ? `desktop-pet--peek-${peekSide}` : '',
  ].filter(Boolean).join(' ')
  const progress = presentation.progressPercent
  const showTaskHeading = Boolean(presentation.operation) || operationsDisconnected || petStatus !== 'ready'
  const statusTitle = operationsDisconnected
    ? '正在找回书页'
    : petStatus === 'error'
      ? '小人偶迷路了'
      : petStatus === 'loading'
        ? '揉揉眼睛中'
        : presentation.title

  return (
    <main
      ref={rootRef}
      className={rootClasses}
      data-desktop-pet-state={presentation.state}
      data-desktop-pet-ambient={ambientMode}
      data-desktop-pet-bubble-side={bubbleSide}
      data-desktop-pet-bubble-placement={bubblePlacement}
      data-pet-status={petStatus}
      style={rootStyle}
      onContextMenu={(event) => {
        event.preventDefault()
        if (!menuOpen) wakePet()
        setMenuOpen((open) => !open)
      }}
      onPointerDown={(event) => {
        // Right-click is handled once by contextmenu; dismissing it here first
        // would make the same gesture immediately reopen the menu.
        if (event.button === 0 && !(event.target as Element).closest('.desktop-pet__menu')) {
          setMenuOpen(false)
        }
      }}
    >
      <div className="desktop-pet__aura" aria-hidden="true" />
      <div className="desktop-pet__book-glow" aria-hidden="true"><i /><i /></div>
      <div className="desktop-pet__orbit" aria-hidden="true">
        <i>一</i><i>二</i><i>三</i>
      </div>
      <div className="desktop-pet__ink" aria-hidden="true"><i /><i /><i /></div>
      <div className="desktop-pet__sparks" aria-hidden="true"><i /><i /><i /><i /></div>
      <div className="desktop-pet__drowse" aria-hidden="true"><i /><i /><i /></div>
      <button
        type="button"
        className="desktop-pet__character"
        aria-label={`${presentation.title}。单击换一句悄悄话，显示 5 秒后消失，拖动可移动桌宠，双击打开书斋，右键打开或收起菜单。`}
        onPointerDown={onCharacterPointerDown}
        onPointerEnter={() => {
          if (presentation.state === 'sleeping' && !manualSleepHoverGuard.current) wakePet()
        }}
        onPointerMove={onCharacterPointerMove}
        onPointerLeave={() => { manualSleepHoverGuard.current = false; petRef.current?.resetLook() }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          wakePet()
          petRef.current?.tap()
          setChatterIndex((current) => (current + 1) % chatterLines.length)
          speech.reveal()
        }}
        onDoubleClick={() => void openMain()}
      >
        <PoseCanvas
          ref={petRef}
          outfit={settings.desktop_pet_outfit}
          scale={settings.desktop_pet_scale}
          state={presentation.state}
          ambient={ambientMode}
          bubbleSide={bubbleSide}
          bubblePlacement={bubblePlacement}
          dragging={isDragging}
          peekLayout={peekLayout}
          onPeekRestored={acknowledgePeekRestore}
          onHitRegionChange={updateCharacterRegion}
          onStatusChange={setPetStatus}
        />
      </button>

      {speech.phase !== 'hidden' && <section
        className="desktop-pet__speech"
        data-speech-phase={speech.phase}
        aria-label="桌宠悄悄话"
        role={presentation.state === 'error' ? 'alert' : 'status'}
        aria-live={presentation.state === 'error' ? 'assertive' : 'polite'}
      >
        {showTaskHeading && <>
          <span className="desktop-pet__speech-eyebrow">✦ {presentation.eyebrow}</span>
          <h1>{statusTitle}</h1>
        </>}
        <p key={`${activityKey}:${chatterIndex}`}>{chatterLine}</p>
        {typeof progress === 'number' && (
          <div className="desktop-pet__progress" aria-label={`任务进度 ${progress}%`}>
            <i style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
          </div>
        )}
      </section>}

      {menuOpen && (
        <section className="desktop-pet__menu" aria-label="桌宠菜单">
          <header><strong>司命桌宠</strong><span>{saving ? '保存中…' : '再右键收起'}</span></header>
          <p className="desktop-pet__menu-help">轻点说一句，5 秒后收起<br />拖动陪你走 · 双击回书斋</p>
          <label>
            <span>衣装</span>
            <select aria-label="桌宠衣装" value={settings.desktop_pet_outfit}
              onChange={event => {
                const outfit = event.target.value
                if (isOutfitId(outfit)) void persistSettings({ desktop_pet_outfit: outfit })
              }}>
              {manifest.outfits.map(outfit => <option key={outfit.id} value={outfit.id}>{outfit.label}</option>)}
            </select>
          </label>
          <label>
            <span>小动作</span>
            <select aria-label="桌宠小动作" value={ambientMode}
              disabled={Boolean(basePresentation.operation) || operationsDisconnected || basePresentation.state !== 'idle' || petStatus !== 'ready'}
              onChange={(event) => {
                const action = event.target.value
                wakePet()
                setMenuOpen(false)
                if (action === 'peek-left' || action === 'peek-right') void startPeek(action === 'peek-left' ? 'left' : 'right')
                else if (action === 'reading' || action === 'sleeping') {
                  manualSleepHoverGuard.current = action === 'sleeping'
                  setAmbientMode(action)
                }
              }}>
              <option value="awake">抱书陪你</option>
              <option value="reading">翻翻小书</option>
              <option value="sleeping">坐下打盹</option>
              <option value="peek-left">去左边偷看</option>
              <option value="peek-right">去右边偷看</option>
            </select>
          </label>
          <button type="button" onClick={() => void openMain()}>回到司命书斋</button>
          <button type="button" onClick={() => void openMain('/settings')}>桌宠设置</button>
          <label>
            <span>大小</span>
            <PetSettingsSlider
              label="桌宠大小"
              min={0.7}
              max={1.35}
              step={0.01}
              value={settings.desktop_pet_scale}
              getResizeAnchor={() => windowContext.current ? desktopPetResizeAnchor(windowContext.current) : { x: 'right', y: 'bottom' }}
              onChange={(value, anchor) => previewSettings({ desktop_pet_scale: value }, anchor)}
              onCommit={(value, anchor) => { void persistSettings({ desktop_pet_scale: value }, anchor) }}
            />
          </label>
          <label>
            <span>透明度</span>
            <PetSettingsSlider
              label="桌宠透明度"
              min={0.55}
              max={1}
              step={0.05}
              value={settings.desktop_pet_opacity}
              onChange={value => previewSettings({ desktop_pet_opacity: value })}
              onCommit={value => { void persistSettings({ desktop_pet_opacity: value }) }}
            />
          </label>
          <label className="desktop-pet__toggle">
            <span>始终置顶</span>
            <input
              type="checkbox"
              checked={settings.desktop_pet_on_top}
              onChange={(event) => void persistSettings({ desktop_pet_on_top: event.target.checked })}
            />
          </label>
          <label className="desktop-pet__toggle">
            <span>静音</span>
            <input
              type="checkbox"
              checked={settings.desktop_pet_muted}
              onChange={(event) => {
                if (!event.target.checked) primePetAudio()
                void persistSettings({ desktop_pet_muted: event.target.checked })
              }}
            />
          </label>
          {notice && <p className="desktop-pet__notice">{notice}</p>}
          <button className="desktop-pet__hide" type="button" onClick={() => { wakePet(); void hideDesktopPet() }}>
            暂时隐藏桌宠
          </button>
        </section>
      )}
    </main>
  )
}
