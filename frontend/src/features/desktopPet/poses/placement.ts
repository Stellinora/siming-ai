import type { DesktopPetBubblePlacement, DesktopPetSide } from '../behavior'
import { manifest, posesFor, type OutfitId, type Pose } from './contract'

export const PEEK_BUBBLE_MAX_HEIGHT = 88

export interface PeekLayout {
  normalWidth: number
  normalHeight: number
  width: number
  height: number
  bubbleWidth: number
  bubbleTop: number
  bubbleInset: number
}

// Keep the entry viewport until both native restoration and a measured canvas
// resize have completed. A native bridge reply alone is not a painted resize.
export interface PeekViewport extends PeekLayout {
  side: DesktopPetSide
  scale: number
  nativeRestored: boolean
}

export function normalPeekViewport(layout: PeekViewport, scale: number) {
  const ratio = scale / layout.scale
  return { width: layout.normalWidth * ratio, height: layout.normalHeight * ratio }
}

export function compactPeekLayout(width: number, height: number, outfit: OutfitId): PeekLayout {
  const pose = posesFor(outfit).peeking
  const full = posePlacement(pose, width, height, 'right', 'side', 'left')
  // Include the hair tips and the maximum subtle lean, not just the face.
  const strip = pose.edge!.visibleStripBounds
  const headRight = full.x + (strip[2] + 5) * full.scaleX
  const headBottom = full.y + (strip[3] + 4) * full.scaleY
  const bubbleWidth = Math.min(150, width * 0.48)
  const bubbleInset = Math.ceil(headRight + 14)
  const bubbleTop = Math.round(height * 0.3)
  return {
    normalWidth: width, normalHeight: height, bubbleWidth, bubbleInset, bubbleTop,
    width: Math.min(width, Math.ceil(bubbleInset + bubbleWidth + 12)),
    // Fixed reserve matches the peek bubble's max-height. Changing chatter
    // cannot shrink/grow the native window under the pointer.
    height: Math.min(height, Math.ceil(Math.max(headBottom, bubbleTop + PEEK_BUBBLE_MAX_HEIGHT) + 12)),
  }
}

export function posePlacement(pose: Pose, width: number, height: number,
  bubbleSide: DesktopPetSide, bubblePlacement: DesktopPetBubblePlacement, edge: DesktopPetSide | null,
  reference?: Pick<PeekLayout, 'normalWidth' | 'normalHeight'> | null) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Invalid viewport')
  // One head scale across poses, including the seated pose; never fit each art's
  // own bounding box (that made clicks and pose changes inflate the character).
  const topBubble = bubblePlacement === 'top'
  const normalWidth = reference?.normalWidth ?? width
  const normalHeight = reference?.normalHeight ?? height
  const availableHeight = topBubble ? Math.max(40, normalHeight - 122) : normalHeight * 0.84
  const availableWidth = topBubble ? normalWidth - 12 : normalWidth * 0.49
  const scale = Math.min(availableHeight / 489, availableWidth / 344)
  if (edge) {
    if (!pose.edge) throw new Error('Peeking artwork requires screen-edge anchors')
    const [, top, , bottom] = pose.edge.visibleStripBounds
    return {
      x: edge === 'left' ? -pose.edge.boundaryX * scale : width + pose.edge.boundaryX * scale,
      y: (topBubble ? 122 : 0) + availableHeight / 2 - (top + bottom) / 2 * scale,
      scaleX: edge === 'left' ? scale : -scale,
      scaleY: scale,
    }
  }
  const center = topBubble ? width / 2 : width * (bubbleSide === 'right' ? 0.25 : 0.75)
  return { x: center - manifest.width / 2 * scale,
    y: height * 0.94 - manifest.floor * scale, scaleX: scale, scaleY: scale }
}

// Pointer coordinates are local CSS pixels, not fractions of the transparent
// window. Anchor to the eyes so bubble side, scale and compact edge placement
// cannot bias a pointer resting over the face. Keep the result screen-relative;
// PoseReaction handles the mirrored mesh exactly once.
export function poseLookTarget(pose: Pose, placement: ReturnType<typeof posePlacement>, x: number, y: number): [number, number] {
  if (![x, y, placement.x, placement.y, placement.scaleX, placement.scaleY].every(Number.isFinite)
    || !placement.scaleX || placement.scaleY <= 0) return [0, 0]
  const eyes = pose.eyeRegions
  const anchorX = eyes ? (eyes[0][0] + eyes[1][0]) / 2 : manifest.width / 2
  const anchorY = eyes ? (eyes[0][1] + eyes[1][1]) / 2 : pose.neckY - 50
  const clamp = (value: number) => Math.max(-1, Math.min(1, value))
  return [clamp((x - placement.x - anchorX * placement.scaleX) / (100 * Math.abs(placement.scaleX))),
    clamp((placement.y + anchorY * placement.scaleY - y) / (100 * placement.scaleY))]
}
