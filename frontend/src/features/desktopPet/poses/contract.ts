import rawManifest from './manifest.json'
import type { DesktopPetAmbientMode, DesktopPetSide } from '../behavior'
import { desktopPetPeekSide } from '../behavior'
import type { DesktopPetVisualState } from '../state'

export const POSE_IDS = ['standing', 'reading', 'peeking', 'dozing', 'picked_up'] as const
export type PoseId = typeof POSE_IDS[number]
export const OUTFIT_IDS = ['classic', 'casual'] as const
export type OutfitId = typeof OUTFIT_IDS[number]
export type EyeRegion = [number, number, number, number, number]
export interface Pose {
  id: PoseId
  label: string
  files: string[]
  // Map the shared motion clock's logical blink phases to this outfit's art.
  frameMap?: number[]
  frameMode: 'whole_sprite' | 'local_eyes'
  neckY: number
  hipY: number
  visibleBounds: [number, number, number, number]
  // Optional original-resolution artwork, registered in the common logical
  // 384x576 canvas at render time. Source PNGs remain byte-for-byte untouched.
  source?: { width: number; height: number; scale: number; x: number; y: number }
  eyeRegions?: [EyeRegion, EyeRegion]
  eyeFeather?: number
  edge?: { boundaryX: number; visibleStripBounds: [number, number, number, number] }
}
export interface PoseManifest {
  version: string
  width: number
  height: number
  floor: number
  defaultOutfit: OutfitId
  outfits: { id: OutfitId; label: string; poses: Pose[] }[]
  sha256: Record<string, string>
}
// JSON is validated (including checksums) by the mandatory pet:check build gate.
export const manifest = rawManifest as unknown as PoseManifest
const poseSets = Object.fromEntries(manifest.outfits.map(outfit => [outfit.id,
  Object.fromEntries(outfit.poses.map(pose => [pose.id, pose])),
])) as Record<OutfitId, Record<PoseId, Pose>>

export function isOutfitId(value: unknown): value is OutfitId {
  return OUTFIT_IDS.some(id => id === value)
}

export function posesFor(outfit: OutfitId): Record<PoseId, Pose> {
  if (!isOutfitId(outfit)) throw new Error(`未知桌宠衣装：${String(outfit)}`)
  return poseSets[outfit]
}

export function poseFrameFile(pose: Pose, frame: number): string {
  const file = pose.files[pose.frameMap ? pose.frameMap[frame] : frame]
  if (!Number.isInteger(frame) || frame < 0 || !file) throw new Error(`Missing pose frame: ${pose.id}/${frame}`)
  return file
}

export function poseArtRect(pose: Pose): [number, number, number, number] {
  const source = pose.source
  return source ? [source.x, source.y, source.width * source.scale, source.height * source.scale]
    : [0, 0, manifest.width, manifest.height]
}

// Dragging is a temporary visual override, never a change to the operation's
// business state. Releasing it resumes the current task/ambient presentation.
export function selectPose(state: DesktopPetVisualState, ambient: DesktopPetAmbientMode, dragging = false): {
  id: PoseId; edge: DesktopPetSide | null
} {
  if (dragging) return { id: 'picked_up', edge: null }
  if (state === 'thinking' || state === 'writing') return { id: 'reading', edge: null }
  if (state === 'sleeping') return { id: 'dozing', edge: null }
  if (state !== 'idle') return { id: 'standing', edge: null }
  const edge = desktopPetPeekSide(ambient)
  if (edge) return { id: 'peeking', edge }
  return { id: ambient === 'reading' ? 'reading' : 'standing', edge: null }
}

export async function loadPoseImages(signal: AbortSignal, outfit: OutfitId): Promise<Map<string, HTMLImageElement>> {
  const images = new Map<string, HTMLImageElement>()
  const poses = Object.values(posesFor(outfit))
  const dimensions = new Map(poses.flatMap(pose => pose.files.map(file =>
    [file, [pose.source?.width ?? manifest.width, pose.source?.height ?? manifest.height]] as const)))
  await Promise.all([...dimensions.keys()].map(file => new Promise<void>((resolve, reject) => {
    const image = new Image()
    const finish = (error?: Error) => {
      image.onload = null
      image.onerror = null
      signal.removeEventListener('abort', abort)
      if (error) { image.src = ''; reject(error) }
      else { images.set(file, image); resolve() }
    }
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    const expected = dimensions.get(file)
    image.onload = () => finish(expected && image.naturalWidth === expected[0] && image.naturalHeight === expected[1]
      ? undefined : new Error(`桌宠素材尺寸不正确：${file}`))
    image.onerror = () => finish(new Error(`桌宠素材加载失败：${file}`))
    image.src = `/desktop-pet/poses/${file}?v=${manifest.sha256[file]}`
  })))
  return images
}
