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
 *   --image-size 1000                 square image size in pixels; a half-size copy is made too
 *   --image-samples 24                sub-pixel frames averaged per image
 *   --image-quality photo|still       photo (default) path traces the metal; still is faster
 *   --photo-samples 96
 *   --video-size 540 --frames 96 --fps 20 --video-samples 6   (--no-video to skip)
 *   --force                           re-render variants that already exist
 *
 * Output: <out-dir>/media/manifest.json and <out-dir>/media/<combo>/<metal>-<shape>-<colour>/
 *   {view}.webp, {view}-half.webp and spin.mp4 (H.264, +faststart, no audio, loops seamlessly).
 * Needs ffmpeg on the PATH. See headless.mjs for the browser.
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
const imageSize = Number(option('image-size', '1000'));
const imageSamples = Number(option('image-samples', '24'));
const imageQuality = option('image-quality', 'photo');
const photoSamples = Number(option('photo-samples', '96'));
const video = !args.includes('--no-video');
const videoSize = Number(option('video-size', '540'));
const frames = Number(option('frames', '96'));
const fps = Number(option('fps', '20'));
const videoSamples = Number(option('video-samples', '6'));
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

const manifest = {
  version: 1,
  generated: new Date().toISOString(),
  imageSize, halfSize: Math.round(imageSize / 2), videoSize,
  views: views.map((id) => ({ id, label: labels.views[id] ?? id })),
  metals: Object.fromEntries(metals.map((m) => [m, labels.metals[m]])),
  colours: Object.fromEntries([...new Set([...colours, ...shapeColours])].map((c) => [c, { label: COLOURS[c].label, swatch: labels.stones[COLOURS[c].stone].swatch }])),
  shapes: {},
  combos: [],
};

const started = Date.now();
let rendered = 0;
for (const combo of combos) {
  const id = `${slug(combo.headLabel)}-on-${slug(combo.shankLabel)}`;
  const designed = await rv((h) => window.ringViewer.designedShape(h), combo.head);
  const available = await rv((h) => window.ringViewer.shapes(h), combo.head);
  const shapes = shapesOption === 'designed' ? [designed] : shapesOption === 'all' ? available : shapesOption.split(',').filter((s) => available.includes(s));
  for (const s of shapes) manifest.shapes[s] = { label: labels.shapes[s] ?? s };
  const entry = { id, head: combo.head, shank: combo.shank, headLabel: combo.headLabel, shankLabel: combo.shankLabel, designedShape: designed, variants: {} };
  manifest.combos.push(entry);

  for (const shape of shapes) {
    for (const metal of metals) {
      for (const colour of shape === designed ? colours : shapeColours) {
        const key = `${metal}.${shape}.${colour}`;
        const dir = `${id}/${metal}-${shape}-${colour}`;
        const abs = join(mediaDir, dir);
        const variant = { metal, shape, colour, dir, views, video: video ? 'spin.mp4' : null };
        const done = views.every((v) => existsSync(join(abs, `${v}.webp`))) && (!video || existsSync(join(abs, 'spin.mp4')));
        if (done && !force) {
          entry.variants[key] = previous?.combos?.find((c) => c.id === id)?.variants?.[key] ?? variant;
          continue;
        }
        mkdirSync(abs, { recursive: true });
        const t = Date.now();
        const config = { head: combo.head, shank: combo.shank, metal, stone: COLOURS[colour].stone, accent: 'diamond', shape, studio: 'white' };

        // Photos: one per view, plus a half-size copy for phones and thumbnails.
        await page.setViewportSize({ width: imageSize, height: imageSize });
        for (const view of views) {
          await rv((c) => window.ringViewer.prepare(c), { ...config, view, angle: 0 });
          await rv((n) => window.ringViewer.renderNow({ samples: n }), imageSamples);
          if (imageQuality === 'photo') await rv((n) => window.ringViewer.photo(n), photoSamples);
          const png = join(abs, `${view}.png`);
          writeFileSync(png, bytesOf(await rv(() => window.ringViewer.capture('image/png'))));
          ffmpeg('-i', png, '-c:v', 'libwebp', '-quality', '88', '-compression_level', '6', join(abs, `${view}.webp`));
          ffmpeg('-i', png, '-vf', `scale=${manifest.halfSize}:-1:flags=lanczos`, '-c:v', 'libwebp', '-quality', '86', '-compression_level', '6', join(abs, `${view}-half.webp`));
          rmSync(png);
        }

        // Turntable: the ring turns once under fixed lights, from the angled view.
        if (video) {
          await page.setViewportSize({ width: videoSize, height: videoSize });
          await rv((c) => window.ringViewer.prepare(c), { ...config, view: 'threequarter', angle: 0 });
          const tmp = mkdtempSync(join(tmpdir(), 'ring-spin-'));
          for (let f = 0; f < frames; f++) {
            const jpg = await rv(({ angle, n }) => {
              window.ringViewer.renderNow({ angle, samples: n });
              return window.ringViewer.capture('image/jpeg', 0.95);
            }, { angle: (f / frames) * Math.PI * 2, n: videoSamples });
            writeFileSync(join(tmp, `${String(f).padStart(4, '0')}.jpg`), bytesOf(jpg));
          }
          ffmpeg('-framerate', String(fps), '-i', join(tmp, '%04d.jpg'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '22',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', join(abs, 'spin.mp4'));
          rmSync(tmp, { recursive: true });
        }
        entry.variants[key] = variant;
        rendered++;
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        console.log(`${dir} (${((Date.now() - t) / 1000).toFixed(0)} s)`);
      }
    }
  }
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`${rendered} variants rendered in ${((Date.now() - started) / 60000).toFixed(1)} min; manifest at ${manifestPath}`);
await viewer.close();
