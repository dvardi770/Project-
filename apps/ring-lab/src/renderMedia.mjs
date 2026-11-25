/**
 * Media renderer: product photos from four angles and a 360° turntable video, on white, for
 * every head and shank that fit, in each metal, centre stone colour and shape.
 *
 *   node src/renderMedia.mjs <out-dir> [options]
 *
 *   --metals white,yellow,rose        metals (keys of the viewer's METALS)
 *   --colours white,yellow,pink,blue  centre diamond colours
 *   --shapes designed|all|round,oval  centre stone shapes; shapes other than the head's own are
 *                                     rendered in --shape-colours only (default: white)
 *   --views threequarter,front,side,top
 *   --image-size 1200                 square photo size in pixels; a half-size copy is made too
 *   --image-samples 25                sub-pixel frames averaged per photo (best as 1 + a multiple of 3)
 *   --image-quality photo|still       photo (default) also path traces the metal; still is faster
 *   --photo-samples 96
 *   --video-size 720 --frames 180 --fps 30 --video-samples 13   (--no-video to skip)
 *   --aperture 0.3                    lens opening in mm for a little depth of field (0: none)
 *   --glare 0.1                       soft glow around the brightest sparkles (0: none)
 *   --force                           re-render variants that already exist
 *
 * The photos show the ring standing up; the turntable video shows it lying on its side, as it
 * would rest on a table, turning once under fixed lights (a seamless loop).
 *
 * Variants are rendered most-wanted first: each design's own stone shape with a white diamond in
 * every metal, then the other diamond colours, then the other shapes. The manifest is written
 * after each variant, so a stopped run is usable, and finished variants are skipped on a re-run.
 * A run adds to the manifest: variants from earlier runs (say, another metal) stay listed while
 * their files exist, so a long job can be split into runs, e.g. one per shape.
 *
 * Output: <out-dir>/media/manifest.json and <out-dir>/media/<combo>/<metal>-<shape>-<colour>/
 *   {view}.webp and {view}-half.webp, spin.mp4 (H.264, +faststart, no audio) and spin-poster.webp
 *   (its first frame). Needs ffmpeg on the PATH. See headless.mjs for the browser.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesOf, openViewer, options, slug } from './headless.mjs';

const args = process.argv.slice(2);
const outDir = args[0]?.startsWith('--') ? undefined : args[0];
const option = options(args);
if (!outDir || !existsSync(join(outDir, 'rings.json'))) {
  console.error('usage: node src/renderMedia.mjs <out-dir> [--metals a,b] [--colours a,b] [--shapes designed|all|a,b] [--no-video] ...');
  process.exit(1);
}
const list = (name, fallback) => option(name, fallback).split(',').map((s) => s.trim()).filter(Boolean);
const metals = list('metals', 'white,yellow,rose');
const colours = list('colours', 'white,yellow,pink,blue');
const shapesOption = option('shapes', 'designed');
const shapeColours = list('shape-colours', 'white');
const views = list('views', 'threequarter,front,side,top');
const imageSize = Number(option('image-size', '1200'));
const imageSamples = Number(option('image-samples', '25'));
const imageQuality = option('image-quality', 'photo');
const photoSamples = Number(option('photo-samples', '96'));
const video = !args.includes('--no-video');
const videoSize = Number(option('video-size', '720'));
const frames = Number(option('frames', '180'));
const fps = Number(option('fps', '30'));
const videoSamples = Number(option('video-samples', '13'));
const aperture = Number(option('aperture', '0.3'));
const glare = Number(option('glare', '0.1'));
const force = args.includes('--force');

// Centre diamond colours offered to customers, and the viewer stone each is drawn with.
const COLOURS = {
  white: { stone: 'diamond', label: 'White' },
  yellow: { stone: 'yellow', label: 'Yellow' },
  pink: { stone: 'pinkdiamond', label: 'Pink' },
  blue: { stone: 'bluediamond', label: 'Blue' },
};
for (const c of [...colours, ...shapeColours]) if (!COLOURS[c]) throw new Error(`unknown colour ${c}; use ${Object.keys(COLOURS).join(', ')}`);

const ffmpeg = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
const mediaDir = join(outDir, 'media');
mkdirSync(mediaDir, { recursive: true });
const manifestPath = join(mediaDir, 'manifest.json');
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;

const viewer = await openViewer(outDir, { width: imageSize, height: imageSize });
const { page } = viewer;
const rv = (fn, arg) => page.evaluate(fn, arg);
const labels = await rv(() => window.ringViewer.labels());
const combos = await rv(() => window.ringViewer.combos());

// A run adds to what earlier runs rendered (another metal, another shape), so the manifest keeps
// their choices and every earlier variant whose files are still there.
const manifest = {
  version: 1,
  generated: new Date().toISOString(),
  imageSize, halfSize: Math.round(imageSize / 2), videoSize,
  views: [...new Map([...(previous?.views ?? []), ...views.map((id) => ({ id, label: labels.views[id] ?? id }))].map((v) => [v.id, v])).values()],
  metals: { ...previous?.metals, ...Object.fromEntries(metals.map((m) => [m, labels.metals[m]])) },
  colours: { ...previous?.colours, ...Object.fromEntries([...new Set([...colours, ...shapeColours])].map((c) => [c, { label: COLOURS[c].label, swatch: labels.stones[COLOURS[c].stone].swatch }])) },
  shapes: { ...previous?.shapes },
  combos: [],
};

// Every variant to render, with its priority.
const jobs = [];
for (const combo of combos) {
  const id = `${slug(combo.headLabel)}-on-${slug(combo.shankLabel)}`;
  const designed = await rv((h) => window.ringViewer.designedShape(h), combo.head);
  const available = await rv((h) => window.ringViewer.shapes(h), combo.head);
  const shapes = shapesOption === 'designed' ? [designed] : shapesOption === 'all' ? available : shapesOption.split(',').filter((s) => available.includes(s));
  for (const s of shapes) manifest.shapes[s] = { label: labels.shapes[s] ?? s };
  const earlier = previous?.combos?.find((c) => c.id === id)?.variants ?? {};
  const kept = Object.fromEntries(Object.entries(earlier).filter(([, v]) => existsSync(join(mediaDir, v.dir, `${v.views[0]}.webp`))));
  const entry = { id, head: combo.head, shank: combo.shank, headLabel: combo.headLabel, shankLabel: combo.shankLabel, designedShape: designed, variants: kept };
  manifest.combos.push(entry);
  for (const shape of shapes) {
    for (const metal of metals) {
      for (const colour of shape === designed ? colours : shapeColours) {
        const tier = shape !== designed ? 2 : colour === 'white' ? 0 : 1;
        jobs.push({ tier, combo, entry, shape, metal, colour });
      }
    }
  }
}
jobs.sort((a, b) => a.tier - b.tier);

const started = Date.now();
let rendered = 0;
for (const { combo, entry, shape, metal, colour } of jobs) {
  const key = `${metal}.${shape}.${colour}`;
  const dir = `${entry.id}/${metal}-${shape}-${colour}`;
  const abs = join(mediaDir, dir);
  const variant = { metal, shape, colour, dir, views, video: video ? 'spin.mp4' : null, poster: video ? 'spin-poster.webp' : null };
  const done = views.every((v) => existsSync(join(abs, `${v}.webp`))) && (!video || existsSync(join(abs, 'spin.mp4')));
  if (done && !force) {
    entry.variants[key] ??= variant;
    continue;
  }
  mkdirSync(abs, { recursive: true });
  const t = Date.now();
  const config = { head: combo.head, shank: combo.shank, metal, stone: COLOURS[colour].stone, accent: 'diamond', shape, studio: 'white' };

  // Photos: the ring standing up, one per view, plus a half-size copy for phones and thumbnails.
  await page.setViewportSize({ width: imageSize, height: imageSize });
  for (const view of views) {
    await rv((c) => window.ringViewer.prepare(c), { ...config, pose: 'upright', view, angle: 0 });
    await rv((o) => window.ringViewer.renderNow(o), { samples: imageSamples, aperture, glare });
    if (imageQuality === 'photo') await rv((n) => window.ringViewer.photo(n), photoSamples);
    const png = join(abs, `${view}.png`);
    writeFileSync(png, bytesOf(await rv(() => window.ringViewer.capture('image/png'))));
    ffmpeg('-i', png, '-c:v', 'libwebp', '-quality', '90', '-compression_level', '6', join(abs, `${view}.webp`));
    ffmpeg('-i', png, '-vf', `scale=${manifest.halfSize}:-1:flags=lanczos`, '-c:v', 'libwebp', '-quality', '88', '-compression_level', '6', join(abs, `${view}-half.webp`));
    rmSync(png);
  }

  // Turntable: the ring lying on its side turns once under fixed lights, filmed from above.
  if (video) {
    await page.setViewportSize({ width: videoSize, height: videoSize });
    await rv((c) => window.ringViewer.prepare(c), { ...config, pose: 'flat', view: 'turntable', angle: 0 });
    const tmp = mkdtempSync(join(tmpdir(), 'ring-spin-'));
    for (let f = 0; f < frames; f++) {
      const png = await rv((o) => {
        window.ringViewer.renderNow(o);
        return window.ringViewer.capture('image/png');
      }, { angle: (f / frames) * Math.PI * 2, samples: videoSamples, aperture, glare });
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
