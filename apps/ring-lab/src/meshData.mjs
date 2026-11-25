/**
 * Compact mesh storage for the ring lab (format 2).
 *
 * Each mesh is stored as one interleaved vertex buffer and one index buffer, both compressed
 * with meshoptimizer's codecs (the ones glTF's EXT_meshopt_compression uses):
 *
 *   vertex (12 bytes): position as 3 x uint16 quantised to the mesh's bounding box,
 *                      ambient occlusion uint8, padding uint8,
 *                      normal as 2 x int16 octahedral encoding.
 *
 * Quantising to 16 bits over a ring part (about 25 mm) keeps positions to under half a micron.
 * Decoding lives in configurator/engine/meshDecode.mjs (the 3D pages load it in the browser) and is
 * re-exported here. The CAD lab viewer (one HTML file) has its own copy; keep them in step.
 */
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { VERTEX_SIZE } from '../configurator/engine/meshDecode.mjs';

export { VERTEX_SIZE, decodeMesh } from '../configurator/engine/meshDecode.mjs';

function octEncode(x, y, z) {
  const s = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / s, v = y / s;
  if (z < 0) {
    const pu = u, pv = v;
    u = (1 - Math.abs(pv)) * (pu >= 0 ? 1 : -1);
    v = (1 - Math.abs(pu)) * (pv >= 0 ? 1 : -1);
  }
  return [Math.round(u * 32767), Math.round(v * 32767)];
}

/**
 * @param {{ P: Float32Array, N: Float32Array, I: Uint32Array }} mesh positions, normals, triangle indices
 * @param {Float32Array | null} ao ambient occlusion 0..1 per vertex, or null
 * @param {(bytes: Uint8Array) => number} push stores bytes and returns their offset
 */
export async function encodeMesh(mesh, ao, push) {
  await MeshoptEncoder.ready;
  const indices = Uint32Array.from(mesh.I);
  const count = mesh.P.length / 3;
  // Reorder for the GPU's vertex cache; this also makes both buffers compress better.
  const [remap, unique] = MeshoptEncoder.reorderMesh(indices, true, false);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.P.length; i++) { const k = i % 3; min[k] = Math.min(min[k], mesh.P[i]); max[k] = Math.max(max[k], mesh.P[i]); }
  const ext = max.map((v, k) => Math.max(v - min[k], 1e-9));
  const vb = new ArrayBuffer(unique * VERTEX_SIZE);
  const view = new DataView(vb);
  for (let old = 0; old < count; old++) {
    const at = remap[old];
    if (at === 0xffffffff) continue;
    const o = at * VERTEX_SIZE;
    for (let k = 0; k < 3; k++) view.setUint16(o + k * 2, Math.round(((mesh.P[old * 3 + k] - min[k]) / ext[k]) * 65535), true);
    view.setUint8(o + 6, ao ? Math.round(Math.max(0, Math.min(1, ao[old])) * 255) : 255);
    const [u, v] = octEncode(mesh.N[old * 3], mesh.N[old * 3 + 1], mesh.N[old * 3 + 2]);
    view.setInt16(o + 8, u, true);
    view.setInt16(o + 10, v, true);
  }
  const idx32 = unique > 65535;
  const ib = idx32 ? indices : Uint16Array.from(indices);
  const vbz = MeshoptEncoder.encodeVertexBuffer(new Uint8Array(vb), unique, VERTEX_SIZE);
  const ibz = MeshoptEncoder.encodeIndexBuffer(new Uint8Array(ib.buffer, ib.byteOffset, ib.byteLength), ib.length, idx32 ? 4 : 2);
  return {
    v: unique, i: ib.length, idx32, min, ext,
    vb: push(vbz), vbLen: vbz.length, ib: push(ibz), ibLen: ibz.length,
  };
}

