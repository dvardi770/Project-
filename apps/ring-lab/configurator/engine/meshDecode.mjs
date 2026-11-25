/**
 * Decoder for the ring lab's compact mesh format (see src/meshData.mjs, which writes it).
 * Lives here so the 3D viewer pages can load it in the browser; src/meshData.mjs re-exports it.
 * The CAD lab viewer (viewer/index.html) keeps its own inline copy; keep them in step.
 */
import { MeshoptDecoder } from 'meshoptimizer/decoder';

export const VERTEX_SIZE = 12;

function octDecode(u, v, out, at) {
  let x = u / 32767, y = v / 32767;
  const z = 1 - Math.abs(x) - Math.abs(y);
  const t = Math.max(-z, 0);
  x += x >= 0 ? -t : t;
  y += y >= 0 ? -t : t;
  const len = Math.hypot(x, y, z) || 1;
  out[at] = x / len; out[at + 1] = y / len; out[at + 2] = z / len;
}

/**
 * @param {object} rec a record written by encodeMesh
 * @param {ArrayBuffer} buffer the whole data buffer
 * @returns {Promise<{ positions: Float32Array, normals: Float32Array, ao: Uint8Array, index: Uint16Array | Uint32Array }>}
 */
export async function decodeMesh(rec, buffer) {
  await MeshoptDecoder.ready;
  const raw = new Uint8Array(rec.v * VERTEX_SIZE);
  MeshoptDecoder.decodeVertexBuffer(raw, rec.v, VERTEX_SIZE, new Uint8Array(buffer, rec.vb, rec.vbLen));
  const index = rec.idx32 ? new Uint32Array(rec.i) : new Uint16Array(rec.i);
  MeshoptDecoder.decodeIndexBuffer(new Uint8Array(index.buffer), rec.i, rec.idx32 ? 4 : 2, new Uint8Array(buffer, rec.ib, rec.ibLen));
  const view = new DataView(raw.buffer);
  const positions = new Float32Array(rec.v * 3), normals = new Float32Array(rec.v * 3), ao = new Uint8Array(rec.v);
  for (let i = 0; i < rec.v; i++) {
    const o = i * VERTEX_SIZE;
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = rec.min[k] + (view.getUint16(o + k * 2, true) / 65535) * rec.ext[k];
    ao[i] = view.getUint8(o + 6);
    octDecode(view.getInt16(o + 8, true), view.getInt16(o + 10, true), normals, i * 3);
  }
  return { positions, normals, ao, index };
}
