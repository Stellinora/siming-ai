import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'src/features/desktopPet/poses/manifest.json'), 'utf8'))
const publicRoot = join(root, 'public/desktop-pet')
assert.deepEqual((await readdir(publicRoot)).sort(), ['poses'], 'Only the current pose runtime may ship')
assert.equal(manifest.width, 384)
assert.equal(manifest.height, 576)
assert.equal(manifest.floor, 560)
assert.equal(manifest.defaultOutfit, 'classic')
assert.deepEqual(manifest.outfits.map(outfit => outfit.id), ['classic', 'casual'])
for (const outfit of manifest.outfits) {
  assert.deepEqual(outfit.poses.map(pose => pose.id), ['standing', 'reading', 'peeking', 'dozing', 'picked_up'])
  assert.equal(outfit.poses.flatMap(pose => pose.files).length, outfit.id === 'classic' ? 15 : 13)
  if (outfit.id === 'casual') assert.ok(outfit.poses.every(pose => pose.source &&
    (pose.id === 'dozing' || pose.frameMode === 'local_eyes')))
}
const poses = manifest.outfits.flatMap(outfit => outfit.poses)
const files = poses.flatMap(pose => pose.files)
assert.equal(new Set(files).size, 28)
assert.equal(files.length, 28)
assert.deepEqual([...files].sort(), Object.keys(manifest.sha256).sort())
assert.deepEqual((await readdir(join(publicRoot, 'poses'))).sort(), [...files].sort())
for (const pose of poses) {
  assert.ok(Number.isFinite(pose.neckY) && Number.isFinite(pose.hipY))
  assert.ok(pose.visibleBounds.every(Number.isFinite))
  assert.equal(pose.visibleBounds[3], manifest.floor)
  if (pose.frameMode === 'local_eyes') {
    assert.equal(pose.frameMode, 'local_eyes', 'New blink artwork must be eye-masked')
    assert.equal(pose.files.length, 3)
    assert.equal(pose.eyeRegions.length, 2)
    assert.ok((pose.eyeFeather ?? 0.06) > 0 && (pose.eyeFeather ?? 0.06) < 0.5)
    for (const eye of pose.eyeRegions) {
      assert.equal(eye.length, 5)
      assert.ok(eye.every(Number.isFinite) && eye[2] > 0 && eye[3] > 0)
    }
  } else {
    assert.equal(pose.frameMode, 'whole_sprite')
    assert.equal(pose.files.length, pose.id === 'standing' ? 5 : 1)
  }
  if (pose.frameMap) {
    assert.equal(pose.id, 'standing')
    assert.deepEqual(pose.frameMap, [0, 1, 2, 2, 1])
    assert.ok(pose.frameMap.every(index => Number.isInteger(index) && index >= 0 && index < pose.files.length))
  }
  if (pose.source) {
    const { width, height, scale, x, y } = pose.source
    assert.ok([width, height, scale].every(value => Number.isFinite(value) && value > 0))
    assert.ok([x, y].every(Number.isFinite))
  }
}
const edge = manifest.outfits[0].poses.find(pose => pose.id === 'peeking').edge
assert.equal(edge.boundaryX, 220.44)
assert.deepEqual(edge.visibleStripBounds, [220, 71, 342, 405])
for (const outfit of manifest.outfits) {
  const edge = outfit.poses.find(pose => pose.id === 'peeking').edge
  assert.ok(Number.isFinite(edge.boundaryX) && edge.boundaryX > 0 && edge.boundaryX < manifest.width)
  assert.ok(edge.visibleStripBounds.every(Number.isFinite))
  assert.ok(edge.visibleStripBounds[2] > edge.boundaryX)
}
let bytes = 0
for (const file of files) {
  assert.match(file, /^[a-z0-9-]+\.(webp|png)$/)
  const buffer = await readFile(join(publicRoot, 'poses', file))
  assert.equal(createHash('sha256').update(buffer).digest('hex'), manifest.sha256[file], `Pose texture checksum mismatch: ${file}`)
  if (file.endsWith('.png')) {
    assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    const pose = poses.find(pose => pose.files.includes(file))
    assert.equal(buffer.readUInt32BE(16), pose.source?.width ?? manifest.width)
    assert.equal(buffer.readUInt32BE(20), pose.source?.height ?? manifest.height)
    assert.equal(buffer[25], 6, 'New original PNG sprites must preserve RGBA transparency')
  } else {
    assert.equal(buffer.toString('ascii', 0, 4), 'RIFF')
    assert.equal(buffer.toString('ascii', 8, 12), 'WEBP')
  }
  bytes += buffer.length
}
assert.equal(bytes, 28702651)
console.log(`Desktop pet assets valid: ${manifest.version}, 2 outfits / 5 shared actions / 28 verified textures / ${bytes} bytes; no retired runtime.`)
