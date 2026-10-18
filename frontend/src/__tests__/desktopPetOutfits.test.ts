import { afterEach, describe, expect, it, vi } from 'vitest'
import { isOutfitId, loadPoseImages, manifest, OUTFIT_IDS, POSE_IDS, poseFrameFile, posesFor, type OutfitId } from '../features/desktopPet/poses/contract'
import { blinkFrame, PoseClock } from '../features/desktopPet/poses/motion'
import { compactPeekLayout, posePlacement } from '../features/desktopPet/poses/placement'

afterEach(() => vi.unstubAllGlobals())

describe('one motion contract across desktop pet outfits', () => {
  it('offers two complete outfits without changing the saved/default classic selection', () => {
    expect(manifest.defaultOutfit).toBe('classic')
    expect(manifest.outfits.map(outfit => outfit.id)).toEqual(OUTFIT_IDS)
    expect(manifest.outfits.map(outfit => outfit.poses.flatMap(pose => pose.files).length)).toEqual([15, 13])
    expect(Object.keys(manifest.sha256)).toHaveLength(28)
    expect(isOutfitId('casual')).toBe(true)
    for (const value of [null, undefined, '', 'other', {}]) expect(isOutfitId(value)).toBe(false)
    expect(() => posesFor('other' as OutfitId)).toThrow('未知桌宠衣装')
  })
  it.each(OUTFIT_IDS)('%s supplies every texture required by the same two-minute motion sequence', outfit => {
    const poses = posesFor(outfit)
    expect(Object.keys(poses)).toEqual(POSE_IDS)
    for (const id of POSE_IDS) {
      const pose = poses[id], clock = new PoseClock(id, () => 0.5)
      for (let tick = 0; tick < 1200; tick++) expect(manifest.sha256[poseFrameFile(pose, clock.advance(100).frame)]).toMatch(/^[a-f0-9]{64}$/)
      expect(pose.visibleBounds[3]).toBe(manifest.floor)
    }
  })
  it('adapts the standing blink phase to three drawings while masking only eyes', () => {
    const pose = posesFor('casual').standing
    expect(pose.frameMode).toBe('local_eyes')
    expect(pose.eyeRegions).toHaveLength(2)
    const times = [-0.01, 0.02, 0.055, 0.09, 0.13, 0.16, 0.22, 0.25]
    expect(times.map(time => poseFrameFile(pose, blinkFrame('standing', time))))
      .toEqual([0, 1, 1, 2, 2, 1, 1, 0].map(index => pose.files[index]))
    for (const frame of [-1, 5, NaN, 1.5]) expect(() => poseFrameFile(pose, frame)).toThrow('Missing pose frame')
  })
  it.each(OUTFIT_IDS)('%s preserves scale and pins the complete peeking art to both compact edges', outfit => {
    const poses = posesFor(outfit)
    for (const size of [0.7, 0.8, 1.35]) {
      const width = 340 * size, height = 300 * size
      const scales = POSE_IDS.map(id => posePlacement(poses[id], width, height, 'right', 'side', null).scaleY)
      expect(new Set(scales).size).toBe(1)
      const compact = compactPeekLayout(width, height, outfit)
      expect(compact.width).toBeLessThan(width)
      expect(compact.height).toBeLessThan(height)
      for (const side of ['left', 'right'] as const) {
        const p = posePlacement(poses.peeking, compact.width, compact.height, 'right', 'side', side, compact)
        const edge = poses.peeking.edge!
        expect(p.x + edge.boundaryX * p.scaleX).toBeCloseTo(side === 'left' ? 0 : compact.width)
        expect(p.y + edge.visibleStripBounds[1] * p.scaleY).toBeGreaterThanOrEqual(0)
        expect(p.y + edge.visibleStripBounds[3] * p.scaleY).toBeLessThan(compact.height)
        const eyeX = p.x + poses.peeking.eyeRegions![1][0] * p.scaleX
        expect(eyeX).toBeGreaterThan(0)
        expect(eyeX).toBeLessThan(compact.width)
      }
    }
  })
})

function mockImages(badFile?: string) {
  const requests: string[] = []
  const dimensions = new Map(manifest.outfits.flatMap(outfit => outfit.poses.flatMap(pose => pose.files.map(file =>
    [file, [pose.source?.width ?? manifest.width, pose.source?.height ?? manifest.height]] as const))))
  vi.stubGlobal('Image', class {
    naturalWidth = 0
    naturalHeight = 0
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(value: string) {
      if (!value) return
      requests.push(value)
      const file = value.split('/').pop()!.split('?')[0]
      const [width, height] = dimensions.get(file)!
      this.naturalWidth = file === badFile ? 1 : width
      this.naturalHeight = height
      queueMicrotask(() => this.onload?.())
    }
  })
  return requests
}

describe('outfit-scoped texture loading', () => {
  it.each(OUTFIT_IDS)('loads only %s textures with their authoritative hashes', async outfit => {
    const requests = mockImages()
    const images = await loadPoseImages(new AbortController().signal, outfit)
    const files = Object.values(posesFor(outfit)).flatMap(pose => pose.files)
    expect([...images.keys()].sort()).toEqual([...files].sort())
    expect(requests.sort()).toEqual(files.map(file => `/desktop-pet/poses/${file}?v=${manifest.sha256[file]}`).sort())
  })
  it('aborts a superseded wardrobe load without completing it', async () => {
    mockImages()
    const controller = new AbortController()
    const promise = loadPoseImages(controller.signal, 'casual')
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('fails explicitly on a malformed texture instead of loading another outfit', async () => {
    const requests = mockImages('casual-reading.png')
    await expect(loadPoseImages(new AbortController().signal, 'casual')).rejects.toThrow('素材尺寸不正确')
    expect(requests.every(url => url.includes('/casual-'))).toBe(true)
  })
})
