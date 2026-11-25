/**
 * Media renderer: product photos from four angles and a 360° turntable video, on white, made with
 * the same engine as the ring builder and its live 3D (configurator/viewer.html), so photos,
 * video and 3D match.
 *
 *   node src/renderMedia.mjs <out-dir> [options]
 *
 * <out-dir> holds what to render:
 *   rings.json, rings.b64.txt, fit.json   CAD rings (what convert.mjs writes): each ring's own head
 *                                          and shank (and other heads its fit check accepts)
 *   designs.json                          rings made from measurements, for the ring builder's
 *                                          engine: [{ "id", "label", "design": { head, shank, shape,
 *                                          carat, … } }] (see configurator/engine/ring.mjs)
 *
 *   --metals white,yellow,rose        metals (configurator/engine/materials.mjs)
 *   --colours white,yellow,pink,blue  centre diamond colours
 *   --shapes designed|all|round,oval  centre stone shapes; shapes other than the design's own are
 *                                     rendered in --shape-colours only (default: white)
 *   --only id,id                      only these combos
 *   --views threequarter,front,side,top
 *   --image-size 1200 --image-samples 10
 *   --video-size 720 --frames 150 --fps 30 --video-samples 1   (--no-video to skip)
 *   --force                           re-render variants that already exist
 *
 * The photos show the ring standing; the video shows it lying on its side, turning once under
 * fixed lights (a seamless loop). Variants are rendered most-wanted first (each design's own
 * shape with a white diamond in every metal, then other colours, then other shapes); the
 * manifest is written after each, finished variants are skipped on a re-run, and a run adds to
 * the manifest rather than replacing it.
 *
 * The viewer page and its engine are copied into <out-dir>, so the folder is a complete render
 * collection: the API serves it (RENDERS_DIR) and the ring builder frames viewer.html for 3D.
 *
 * Output: <out-dir>/media/manifest.json and <out-dir>/media/<combo>/<metal>-<shape>-<colour>/
 *   {view}.webp and {view}-half.webp, spin.mp4 (H.264, +faststart, no audio) and spin-poster.webp.
 *   Needs ffmpeg on the PATH. See headless.mjs for the browser.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesOf, openViewer, options, slug } from './headless.mjs';
import { SHAPES } from '../configurator/engine/cuts.mjs';
import { GEMS, METALS } from '../configurator/engine/materials.mjs';
import { gemSwatch } from '../configurator/engine/icons.mjs';

const args = process.argv.slice(2);
const outDir = args[0]?.startsWith('--') ? undefined : args[0];
const option = options(args);
if (!outDir || (!existsSync(join(outDir, 'rings.json')) && !existsSync(join(outDir, 'designs.json')))) {
  console.error('usage: node src/renderMedia.mjs <out-dir with rings.json and/or designs.json> [--metals a,b] [--colours a,b] [--shapes designed|all|a,b] [--no-video] ...');
  process.exit(1);
}
const list = (name, fallback) => option(name, fallback).split(',').map((s) => s.trim()).filter(Boolean);
const metals = list('metals', 'white,yellow,rose');
const colours = list('colours', 'white,yellow,pink,blue');
const shapesOption = option('shapes', 'designed');
const shapeColours = list('shape-colours', 'white');
const only = option('only', '') ? list('only', '') : null;
const views = list('views', 'threequarter,front,side,top');
const imageSize = Number(option('image-size', '1200'));
const imageSamples = Number(option('image-samples', '10'));
const video = !args.includes('--no-video');
const videoSize = Number(option('video-size', '720'));
const frames = Number(option('frames', '150'));
const fps = Number(option('fps', '30'));
const videoSamples = Number(option('video-samples', '1'));
const force = args.includes('--force');

// Centre diamond colours offered to customers, and the stone each is drawn with (viewer.html).
const COLOURS = {
  white: { gem: 'diamond', label: 'White' },
  yellow: { gem: 'yellowdiamond', label: 'Yellow' },
  pink: { gem: 'pinkdiamond', label: 'Pink' },
  blue: { gem: 'bluediamond', label: 'Blue' },
};
for (const c of [...colours, ...shapeColours]) if (!COLOURS[c]) throw new Error(`unknown colour ${c}; use ${Object.keys(COLOURS).join(', ')}`);
for (const m of metals) if (!METALS[m]) throw new Error(`unknown metal ${m}; use ${Object.keys(METALS).join(', ')}`);
const VIEW_LABELS = { threequarter: 'Angled', front: 'Front', side: 'Side', top: 'Top' };

// The collection carries its own viewer and engine.
const configurator = fileURLToPath(new URL('../configurator/', import.meta.url));
mkdirSync(join(outDir, 'engine'), { recursive: true });
copyFileSync(join(configurator, 'viewer.html'), join(outDir, 'viewer.html'));
// The render studio page: the photos, video and 3D of every combo, with its choices.
copyFileSync(fileURLToPath(new URL('../viewer/gallery.html', import.meta.url)), join(outDir, 'gallery.html'));
for (const f of readdirSync(join(configurator, 'engine'))) copyFileSync(join(configurator, 'engine', f), join(outDir, 'engine', f));

const ffmpeg = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
const mediaDir = join(outDir, 'media');
mkdirSync(mediaDir, { recursive: true });
const manifestPath = join(mediaDir, 'manifest.json');
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;

const viewer = await openViewer(outDir, { width: imageSize, height: imageSize, page: 'viewer.html', query: '?render', ready: () => window.studio });
const { page } = viewer;
const rv = (fn, arg) => page.evaluate(fn, arg);

// What to render: CAD rings (each ring's own head and shank) and designs from measurements.
const combos = [];
for (const r of await rv(() => window.studio.cadRings())) {
  if (!r.fits) continue;
  combos.push({
    id: `${slug(r.headLabel)}-on-${slug(r.shankLabel)}`, kind: 'cad', head: r.index, shank: r.index,
    headLabel: r.headLabel, shankLabel: r.shankLabel, label: `${r.headLabel} on ${r.shankLabel}`,
    designedShape: await rv((i) => window.studio.designedShape(i), r.index),
  });
}
if (existsSync(join(outDir, 'designs.json'))) {
  for (const d of JSON.parse(readFileSync(join(outDir, 'designs.json'), 'utf8'))) {
    combos.push({ id: d.id, kind: 'design', design: d.design, label: d.label, headLabel: d.design.head, shankLabel: d.design.shank, designedShape: d.design.shape ?? 'round' });
  }
}

const manifest = {
  version: 1,
  generated: new Date().toISOString(),
  engine: 'configurator',
  imageSize, halfSize: Math.round(imageSize / 2), videoSize,
  views: views.map((id) => ({ id, label: VIEW_LABELS[id] ?? id })),
  metals: Object.fromEntries(metals.map((m) => [m, { label: METALS[m].label, swatch: METALS[m].swatch }])),
  colours: Object.fromEntries([...new Set([...colours, ...shapeColours])].map((c) => [c, { label: COLOURS[c].label, swatch: gemSwatch(GEMS[COLOURS[c].gem].swatch) }])),
  shapes: { ...previous?.shapes },
  combos: [],
};

const jobs = [];
for (const combo of combos) {
  const shapes = shapesOption === 'designed' ? [combo.designedShape] : shapesOption === 'all' ? Object.keys(SHAPES) : shapesOption.split(',').filter((s) => SHAPES[s]);
  if (!shapes.includes(combo.designedShape)) shapes.unshift(combo.designedShape);
  for (const s of shapes) manifest.shapes[s] = { label: SHAPES[s].label };
  // Variants from earlier runs stay listed while their files are there.
  const earlier = previous?.combos?.find((c) => c.id === combo.id)?.variants ?? {};
  const kept = Object.fromEntries(Object.entries(earlier).filter(([, v]) => existsSync(join(mediaDir, v.dir, `${v.views[0]}.webp`))));
  const entry = { ...combo, variants: kept };
  manifest.combos.push(entry);
  if (only && !only.includes(combo.id)) continue;
  for (const shape of shapes) {
    for (const metal of metals) {
      for (const colour of shape === combo.designedShape ? colours : shapeColours) {
        const tier = shape !== combo.designedShape ? 2 : colour === 'white' ? (metal === metals[0] ? 0 : 1) : 3;
        jobs.push({ tier, entry, shape, metal, colour });
      }
    }
  }
}
jobs.sort((a, b) => a.tier - b.tier);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const started = Date.now();
let rendered = 0;
for (const { entry, shape, metal, colour } of jobs) {
  const key = `${metal}.${shape}.${colour}`;
  const dir = `${entry.id}/${metal}-${shape}-${colour}`;
  const abs = join(mediaDir, dir);
  const variant = { metal, shape, colour, dir, views, video: video ? 'spin.mp4' : null, poster: video ? 'spin-poster.webp' : null };
  const done = views.every((v) => existsSync(join(abs, `${v}.webp`))) && (!video || existsSync(join(abs, 'spin.mp4')));
  if (done && !force) { entry.variants[key] ??= variant; continue; }
  mkdirSync(abs, { recursive: true });
  const t = Date.now();
  const spec = { kind: entry.kind, design: entry.design, head: entry.head, shank: entry.shank, metal, shape, colour };

  // Photos: the ring standing, one per view, plus a half-size copy for phones and thumbnails.
  await page.setViewportSize({ width: imageSize, height: imageSize });
  await rv((s) => window.studio.show(s), { ...spec, pose: 'upright' });
  for (const view of views) {
    const png = join(abs, `${view}.png`);
    writeFileSync(png, bytesOf(await rv((o) => window.studio.photo(o), { view, samples: imageSamples })));
    ffmpeg('-i', png, '-c:v', 'libwebp', '-quality', '90', '-compression_level', '6', join(abs, `${view}.webp`));
    ffmpeg('-i', png, '-vf', `scale=${manifest.halfSize}:-1:flags=lanczos`, '-c:v', 'libwebp', '-quality', '88', '-compression_level', '6', join(abs, `${view}-half.webp`));
    rmSync(png);
  }

  // Turntable: the ring lying on its side turns once under fixed lights.
  if (video) {
    await page.setViewportSize({ width: videoSize, height: videoSize });
    await rv((s) => window.studio.show(s), { ...spec, pose: 'flat' });
    const tmp = mkdtempSync(join(tmpdir(), 'ring-spin-'));
    for (let f = 0; f < frames; f++) {
      // Starting with the stone towards the camera, so the first frame makes a good poster.
      const png = await rv((o) => window.studio.turn(o), { angle: Math.PI + (f / frames) * Math.PI * 2, samples: videoSamples });
      writeFileSync(join(tmp, `${String(f).padStart(4, '0')}.png`), bytesOf(png));
    }
    ffmpeg('-framerate', String(fps), '-i', join(tmp, '%04d.png'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
      '-tune', 'film', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', join(abs, 'spin.mp4'));
    ffmpeg('-i', join(tmp, '0000.png'), '-c:v', 'libwebp', '-quality', '86', '-compression_level', '6', join(abs, 'spin-poster.webp'));
    rmSync(tmp, { recursive: true });
  }
  entry.variants[key] = variant;
  rendered++;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`${dir} (${((Date.now() - t) / 1000).toFixed(0)} s)`);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`${rendered} variants rendered in ${((Date.now() - started) / 60000).toFixed(1)} min; manifest at ${manifestPath}`);
await viewer.close();
