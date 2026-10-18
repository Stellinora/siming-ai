import { afterEach, describe, expect, it, vi } from 'vitest'
import { posesFor, type OutfitId } from '../features/desktopPet/poses/contract'
import { stillPoseMotion } from '../features/desktopPet/poses/motion'
import { PoseRenderer } from '../features/desktopPet/poses/renderer'

const poseById = posesFor('classic')

function setup(outfit: OutfitId = 'classic') {
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TEXTURE_2D: 8, LINEAR: 9,
    TEXTURE_MIN_FILTER: 10, TEXTURE_MAG_FILTER: 11, TEXTURE_WRAP_S: 12, TEXTURE_WRAP_T: 13,
    CLAMP_TO_EDGE: 14, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 15, RGBA: 16, UNSIGNED_BYTE: 17,
    COLOR_BUFFER_BIT: 18, TEXTURE0: 19, TEXTURE1: 20, TRIANGLES: 21,
    createShader: vi.fn(() => ({})), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})), attachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true), useProgram: vi.fn(), deleteProgram: vi.fn(),
    createBuffer: vi.fn(() => ({})), bindBuffer: vi.fn(), bufferData: vi.fn(), deleteBuffer: vi.fn(),
    getAttribLocation: vi.fn(() => 0), enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(),
    getUniformLocation: vi.fn((_program, name) => ({ name })),
    uniform1f: vi.fn(), uniform1i: vi.fn(), uniform2f: vi.fn(), uniform3f: vi.fn(), uniform4f: vi.fn(),
    pixelStorei: vi.fn(), createTexture: vi.fn(() => ({})), bindTexture: vi.fn(),
    texParameteri: vi.fn(), texImage2D: vi.fn(), deleteTexture: vi.fn(),
    viewport: vi.fn(), clearColor: vi.fn(), clear: vi.fn(), activeTexture: vi.fn(), drawArrays: vi.fn(),
    isContextLost: vi.fn(() => false), getExtension: vi.fn(() => ({ loseContext: vi.fn() })),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(gl as unknown as WebGLRenderingContext)
  const images = new Map(Object.values(posesFor(outfit)).flatMap(pose => pose.files).map(file => [file, new Image()]))
  return { gl, renderer: new PoseRenderer(images) }
}
afterEach(() => vi.restoreAllMocks())

describe('desktop pet raster density', () => {
  it('uploads only the selected outfit and uses its eye mask/frame registration in the same shader', () => {
    const { gl, renderer } = setup('casual')
    const pose = posesFor('casual').standing
    renderer.draw(pose, { ...stillPoseMotion(), frame: 3 })
    expect(gl.createTexture).toHaveBeenCalledTimes(13)
    expect(gl.texImage2D).toHaveBeenCalledTimes(13)
    expect(gl.uniform1f).toHaveBeenCalledWith({ name: 'localEyes' }, 1)
    expect(gl.uniform1f).toHaveBeenCalledWith({ name: 'eyeFeather' }, .2)
    expect(gl.bindTexture).toHaveBeenLastCalledWith(gl.TEXTURE_2D, gl.createTexture.mock.results[2].value)
    renderer.dispose()
    expect(gl.deleteTexture).toHaveBeenCalledTimes(13)
  })
  it('upgrades the backing store once for high DPI without reloading textures or thrashing near the threshold', () => {
    const { gl, renderer } = setup()
    const pose = poseById.picked_up, motion = stillPoseMotion()
    expect(renderer.draw(pose, motion, 0.77).width).toBe(384)
    expect(renderer.draw(pose, motion, 1.31).width).toBe(768)
    expect(renderer.canvas.height).toBe(1152)
    for (const density of [0.99, 1.01, 0.98, 1.05, 0.7, 2.5]) renderer.draw(pose, motion, density)
    expect(renderer.canvas.width).toBe(768)
    expect(gl.viewport.mock.calls).toEqual([[0, 0, 384, 576], [0, 0, 768, 1152]])
    expect(gl.createTexture).toHaveBeenCalledTimes(15)
    expect(gl.texImage2D).toHaveBeenCalledTimes(15)
    expect(gl.createProgram).toHaveBeenCalledTimes(1)
    expect(gl.uniform2f).toHaveBeenCalledWith({ name: 'size' }, 384, 576)
    renderer.dispose()
    renderer.dispose()
    expect(gl.deleteTexture).toHaveBeenCalledTimes(15)
  })
  it('rejects invalid density and preserves normal single-scale output', () => {
    const { gl, renderer } = setup()
    for (const density of [NaN, Infinity, 0, -1]) {
      expect(() => renderer.draw(poseById.standing, stillPoseMotion(), density)).toThrow(RangeError)
    }
    renderer.draw(poseById.standing, stillPoseMotion())
    expect(renderer.canvas.width).toBe(384)
    expect(gl.viewport).toHaveBeenCalledTimes(1)
    expect(gl.drawArrays).toHaveBeenCalledTimes(1)
    renderer.dispose()
  })
})
