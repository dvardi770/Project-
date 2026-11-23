/**
 * Reads ring CAD files (Rhino / MatrixGold .3dm), splits each ring into its head and
 * shank, and writes compact mesh data for the 3D viewer.
 *
 *   node src/convert.mjs <config.json> <out-dir>
 *
 * config.json lists the rings:
 *   [{ "file": "rings/oval.3dm", "label": "3 oval ring", "head": "Three-stone oval", "shank": "Plain band" }]
 *
 * Output (in <out-dir>): rings.json (parts, stones, placements), rings.b64.txt (vertex data,
 * base64 because the artifact host serves no binary types) and index.html (the viewer).
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import rhino3dm from 'rhino3dm';

const [configPath, outDir] = process.argv.slice(2);
if (!configPath || !outDir) {
  console.error('usage: node src/convert.mjs <config.json> <out-dir>');
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const r = await rhino3dm();

const chunks = [];
let offset = 0;
/** Appends a typed array to the output buffer, 4-byte aligned, and returns its byte offset. */
function push(arr) {
  const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  const at = offset;
  chunks.push(b);
  offset += b.length;
  const pad = (4 - (offset % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
  return at;
}

/** Merges the render meshes saved in the file for one object. Rhino stores these with the CAD's exact normals. */
function meshOf(g) {
  const meshes = [];
  const type = g.constructor.name;
  if (type === 'Brep') {
    const faces = g.faces();
    for (let j = 0; j < faces.count; j++) { const m = faces.get(j).getMesh(r.MeshType.Any); if (m) meshes.push(m); }
  } else if (type === 'Extrusion') {
    const m = g.getMesh(r.MeshType.Any); if (m) meshes.push(m);
  } else if (type === 'Mesh') meshes.push(g);
  const P = [], N = [], I = [];
  for (const m of meshes) {
    const a = m.toThreejsJSON().data;
    const p = a.attributes.position.array;
    const base = P.length / 3;
    for (const v of p) P.push(v);
    if (a.attributes.normal) for (const v of a.attributes.normal.array) N.push(v);
    else for (let k = 0; k < p.length; k++) N.push(0);
    const ix = a.index ? a.index.array : [...Array(p.length / 3).keys()];
    for (const k of ix) I.push(k + base);
  }
  if (!P.length) return null;
  const big = P.length / 3 > 65535;
  return {
    pos: push(new Float32Array(P)), nPos: P.length,
    nrm: push(Int16Array.from(N, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767))),
    idx: push(big ? new Uint32Array(I) : new Uint16Array(I)), nIdx: I.length, idx32: big,
  };
}

const out = { rings: [] };
for (const entry of config) {
  const file = resolve(dirname(configPath), entry.file);
  const doc = r.File3dm.fromByteArray(new Uint8Array(readFileSync(file)));
  const layers = [];
  for (let i = 0; i < doc.layers().count; i++) { const l = doc.layers().get(i); layers.push({ name: l.name, visible: l.visible }); }
  const objects = doc.objects();
  const byId = {};
  for (let i = 0; i < objects.count; i++) { const o = objects.get(i); byId[o.attributes().id] = o; }

  // Stones are usually placed as blocks (one cut, many placements).
  const ring = { label: entry.label, headLabel: entry.head, shankLabel: entry.shank, defs: {}, items: [] };
  const defs = doc.instanceDefinitions();
  for (let i = 0; i < defs.count; i++) {
    const d = defs.get(i);
    const first = byId[d.getObjectIds()[0]];
    ring.defs[d.id] = { name: d.name, mesh: first ? meshOf(first.geometry()) : null };
  }

  // MatrixGold keeps metal on "Metal" layers and stones on "Gem" layers. Hidden layers are design
  // alternatives the designer switched off, so they are skipped.
  for (let i = 0; i < objects.count; i++) {
    const o = objects.get(i);
    const a = o.attributes();
    const g = o.geometry();
    const layer = layers[a.layerIndex];
    if (!layer.visible || !a.visible) continue;
    if (a.mode && a.mode.value === 3) continue; // geometry inside a block definition
    if (!/^(Metal|Gem)/.test(layer.name)) continue;
    const bb = g.getBoundingBox();
    const item = {
      kind: layer.name.startsWith('Gem') ? 'gem' : 'metal', name: a.name || '',
      c: bb.min.map((v, k) => (v + bb.max[k]) / 2), size: bb.max.map((v, k) => v - bb.min[k]), min: bb.min, max: bb.max,
    };
    if (g.constructor.name === 'InstanceReference') { item.def = g.parentIdefId; item.xform = Array.from(g.xform.toFloatArray(true)); }
    else { item.mesh = meshOf(g); if (!item.mesh) continue; }
    ring.items.push(item);
  }

  // Head or shank: the centre stone is the largest stone. Pieces that are not tall (not part of the
  // band) and sit above the finger within the centre stone's reach belong to the head.
  const gems = ring.items.filter((i) => i.kind === 'gem').sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1]);
  const centre = gems[0];
  centre.role = 'centre';
  const reach = Math.max(centre.size[0], centre.size[1]) * 0.5 * 1.55;
  const aboveFinger = centre.min[2] - 4;
  for (const it of ring.items) {
    const tall = it.size[2] > 12;
    it.part = !tall && it.c[2] > aboveFinger && Math.abs(it.c[0]) < reach ? 'head' : 'shank';
  }
  ring.shankTop = Math.max(...ring.items.filter((i) => i.size[2] > 15).map((i) => i.max[2]));
  const count = {};
  for (const it of ring.items) count[`${it.part} ${it.kind}`] = (count[`${it.part} ${it.kind}`] ?? 0) + 1;
  console.log(entry.label, count);
  out.rings.push(ring);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/rings.json`, JSON.stringify(out));
writeFileSync(`${outDir}/rings.b64.txt`, Buffer.concat(chunks).toString('base64'));
copyFileSync(fileURLToPath(new URL('../viewer/index.html', import.meta.url)), `${outDir}/index.html`);
console.log(`wrote ${outDir} (${(offset / 1e6).toFixed(2)} MB of mesh data)`);
