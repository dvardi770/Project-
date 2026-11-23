/**
 * Catalogue renderer: one finished product image (angled view, white background) of every
 * head and shank that fit, in each metal and stone, by driving the viewer in headless Chromium.
 * For the full set of views plus 360° videos, use renderMedia.mjs.
 *
 *   node src/renderCatalogue.mjs <out-dir> [--metals white,yellow,rose,platinum] [--stones diamond]
 *                                [--quality still|photo] [--samples 240] [--size 1024]
 *
 * <out-dir> is what convert.mjs and fitCheck.mjs wrote. Images and manifest.json go to
 * <out-dir>/catalogue, which the viewer shows as a gallery. See headless.mjs for Chromium setup.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bytesOf, openViewer, options, slug } from './headless.mjs';

const args = process.argv.slice(2);
const outDir = args[0]?.startsWith('--') ? undefined : args[0];
const option = options(args);
if (!outDir || !existsSync(join(outDir, 'rings.json'))) {
  console.error('usage: node src/renderCatalogue.mjs <out-dir> [--metals a,b] [--stones a,b] [--quality still|photo] [--samples n] [--size px]');
  process.exit(1);
}
const metals = option('metals', 'white,yellow,rose').split(',');
const stones = option('stones', 'diamond').split(',');
const quality = option('quality', 'photo');
const samples = Number(option('samples', '240'));
const size = Number(option('size', '1024'));

const viewer = await openViewer(outDir, { width: size, height: size });
const { page } = viewer;
const combos = await page.evaluate(() => window.ringViewer.combos());
mkdirSync(join(outDir, 'catalogue'), { recursive: true });
const manifest = [];
const started = Date.now();
for (const combo of combos) {
  for (const metal of metals) {
    for (const stone of stones) {
      const t = Date.now();
      await page.evaluate((c) => window.ringViewer.show(c), { head: combo.head, shank: combo.shank, metal, stone, accent: 'diamond', studio: 'white', view: 'threequarter' });
      if (quality === 'photo') await page.evaluate((n) => window.ringViewer.photo(n), samples);
      const png = await page.evaluate(() => window.ringViewer.capture());
      const file = `${slug(combo.headLabel)}-on-${slug(combo.shankLabel)}-${metal}-${stone}.png`;
      writeFileSync(join(outDir, 'catalogue', file), bytesOf(png));
      manifest.push({ file, head: combo.head, shank: combo.shank, headLabel: combo.headLabel, shankLabel: combo.shankLabel, metal, stone, quality });
      console.log(`${file} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    }
  }
}
writeFileSync(join(outDir, 'catalogue', 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`${manifest.length} images in ${((Date.now() - started) / 1000).toFixed(0)} s`);
await viewer.close();
