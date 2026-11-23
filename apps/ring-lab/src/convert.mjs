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
 *
 * Two things are worked out here once, so the viewer does not have to:
 * - Ambient occlusion for every metal vertex: how much of the surroundings nearby metal and
 *   stones hide from it. Crevices under a halo or between prongs come out darker, as in a photo.
 * - Each stone cut's flat facets (the planes of its convex hull). The viewer traces light
 *   against these planes, which is exact for convex cuts and cheaper than searching triangles.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import rhino3dm from 'rhino3dm';
import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { MeshBVH } from 'three-mesh-bvh';
import { encodeMesh } from './meshData.mjs';

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
function rawMesh(g) {
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
  return { P: new Float32Array(P), N: new Float32Array(N), I: new Uint32Array(I) };
}

/** Compresses a mesh into the output buffer (see meshData.mjs); `ao` (0..1 per vertex) is optional. */
const emit = (m, ao) => encodeMesh(m, ao ?? null, push);

/** The planes of a stone's convex hull, nearly coplanar ones merged. Flat [nx, ny, nz, d] with n·x = d. */
function facetPlanes(P, I) {
  const pts = [];
  for (let i = 0; i < P.length; i += 3) pts.push(new THREE.Vector3(P[i], P[i + 1], P[i + 2]));
  const hull = new ConvexHull().setFromPoints(pts);
  const planes = [];
  let hullVolume = 0;
  for (const f of hull.faces) {
    const n = f.normal.clone();
    const d = n.dot(f.midpoint);
    const same = planes.find((q) => q.n.dot(n) > 0.995 && Math.abs(q.d - d) < 0.05);
    if (!same) planes.push({ n, d });
    let e = f.edge;
    const a = e.head().point; e = e.next;
    const b = e.head().point; e = e.next;
    hullVolume += a.dot(b.clone().cross(e.head().point)) / 6;
  }
  let meshVolume = 0;
  const v = (k) => new THREE.Vector3(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]);
  for (let t = 0; t < I.length; t += 3) meshVolume += v(I[t]).dot(v(I[t + 1]).cross(v(I[t + 2]))) / 6;
  // A cut is convex when it fills its hull. Heart shapes, for example, do not.
  const convex = Math.abs(meshVolume) / Math.abs(hullVolume) > 0.985;
  return { convex, planes: planes.flatMap((q) => [...q.n.toArray(), q.d].map((x) => Math.round(x * 1e5) / 1e5)) };
}

// Ambient occlusion: rays per vertex and how far nearby geometry counts (millimetres).
const AO_RAYS = 24, AO_RANGE = 1.6;
const hemisphere = Array.from({ length: AO_RAYS }, (_, i) => {
  // Cosine-weighted, evenly spread directions around +Z (golden-angle spiral).
  const u = (i + 0.5) / AO_RAYS, phi = i * 2.399963;
  const r = Math.sqrt(u);
  return new THREE.Vector3(r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - u));
});
function bakeOcclusion(meshes, occluders) {
  const geo = new THREE.BufferGeometry();
  let count = 0;
  for (const o of occluders) count += o.P.length;
  const pos = new Float32Array(count);
  const idx = [];
  let at = 0;
  for (const o of occluders) {
    const base = at / 3;
    pos.set(o.P, at);
    at += o.P.length;
    for (const k of o.I) idx.push(k + base);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  const bvh = new MeshBVH(geo);
  const ray = new THREE.Ray(), n = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), q = new THREE.Quaternion(), z = new THREE.Vector3(0, 0, 1);
  return meshes.map((m) => {
    const ao = new Float32Array(m.P.length / 3);
    for (let i = 0; i < ao.length; i++) {
      n.set(m.N[i * 3], m.N[i * 3 + 1], m.N[i * 3 + 2]);
      if (n.lengthSq() < 0.5) { ao[i] = 1; continue; }
      n.normalize();
      q.setFromUnitVectors(z, n);
      const spin = (i * 0.618034) % 1 * Math.PI * 2; // vary the pattern per vertex to avoid banding
      let hidden = 0;
      for (const h of hemisphere) {
        t1.copy(h).applyAxisAngle(z, spin).applyQuaternion(q);
        ray.origin.set(m.P[i * 3], m.P[i * 3 + 1], m.P[i * 3 + 2]).addScaledVector(n, 0.01);
        ray.direction.copy(t1);
        const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, AO_RANGE);
        if (hit) hidden += 1 - hit.distance / AO_RANGE;
      }
      ao[i] = 1 - hidden / AO_RAYS;
    }
    return ao;
  });
}

const out = { format: 2, rings: [] };
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
    const raw = first ? rawMesh(first.geometry()) : null;
    ring.defs[d.id] = { name: d.name, raw };
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
    else { item.raw = rawMesh(g); if (!item.raw) continue; }
    ring.items.push(item);
  }

  // Occlusion is baked with the ring as designed: all of its metal and every placed stone.
  const placed = ring.items.filter((i) => i.def && ring.defs[i.def]?.raw).map((i) => {
    const src = ring.defs[i.def].raw;
    const m = new THREE.Matrix4().set(...i.xform);
    const P = Float32Array.from(src.P);
    new THREE.BufferAttribute(P, 3).applyMatrix4(m);
    return { P, I: src.I };
  });
  const metal = ring.items.filter((i) => i.kind === 'metal' && i.raw);
  const started = Date.now();
  const occlusion = bakeOcclusion(metal.map((i) => i.raw), [...metal.map((i) => i.raw), ...ring.items.filter((i) => i.kind === 'gem' && i.raw).map((i) => i.raw), ...placed]);
  console.log(`${entry.label}: ambient occlusion for ${metal.length} metal pieces in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  for (const [k, it] of metal.entries()) it.mesh = await emit(it.raw, occlusion[k]);
  for (const it of ring.items) {
    if (it.raw && !it.mesh) it.mesh = await emit(it.raw);
    delete it.raw;
  }
  for (const d of Object.values(ring.defs)) {
    if (d.raw) Object.assign(d, facetPlanes(d.raw.P, d.raw.I), { mesh: await emit(d.raw) });
    else d.mesh = null;
    delete d.raw;
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
