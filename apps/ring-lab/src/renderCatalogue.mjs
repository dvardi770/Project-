/**
 * Catalogue renderer: saves a finished product image of every head and shank that fit,
 * in each metal and stone, by driving the viewer in headless Chromium.
 *
 *   node src/renderCatalogue.mjs <out-dir> [--metals white,yellow,rose,platinum] [--stones diamond]
 *                                [--quality still|photo] [--samples 240] [--size 1024]
 *
 * <out-dir> is what convert.mjs and fitCheck.mjs wrote. Images and manifest.json go to
 * <out-dir>/catalogue, which the viewer shows as a gallery.
 *
 * The viewer's libraries are served from this package's node_modules instead of the CDN, so
 * the versions match and no internet access is needed. Chromium comes from Playwright
 * (`npx playwright install chromium` on a new machine). By default it renders in software,
 * which works anywhere but is slow; on a machine with a GPU, set RING_LAB_CHROMIUM_ARGS to
 * flags that enable it (for example "--use-angle=vulkan --enable-features=Vulkan").
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const outDir = args[0]?.startsWith('--') ? undefined : args[0];
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
if (!outDir || !existsSync(join(outDir, 'rings.json'))) {
  console.error('usage: node src/renderCatalogue.mjs <out-dir> [--metals a,b] [--stones a,b] [--quality still|photo] [--samples n] [--size px]');
  process.exit(1);
}
const metals = option('metals', 'white,yellow,rose').split(',');
const stones = option('stones', 'diamond').split(',');
const quality = option('quality', 'photo');
const samples = Number(option('samples', '240'));
const size = Number(option('size', '1024'));

// Static server for the viewer and its data.
const types = { '.html': 'text/html', '.json': 'application/json', '.txt': 'text/plain', '.png': 'image/png' };
const root = resolve(outDir);
const server = createServer((req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/') path = '/index.html';
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) return res.writeHead(404).end();
  let body = readFileSync(file);
  // The artifact host wraps the page in a document; do the same here.
  if (file.endsWith('.html')) body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`;
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

// pnpm links this package's dependencies here.
const modules = fileURLToPath(new URL('../node_modules/', import.meta.url));
const packageDir = (name) => join(modules, name);

const browser = await chromium.launch({
  args: (process.env.RING_LAB_CHROMIUM_ARGS ?? '--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist').split(' ').filter(Boolean),
});
// The stage is square below 860 px wide; two device pixels per CSS pixel gives `size` pixels.
const page = await browser.newPage({ viewport: { width: Math.ceil(size / 2) + 32, height: 1200 }, deviceScaleFactor: 2 });
await page.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/(.+?)@[^/]+\/(.*)$/, (route) => {
  const [, name, file] = route.request().url().match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/(.+?)@[^/]+\/(.*)$/);
  try {
    route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(join(packageDir(name), file)) });
  } catch {
    route.abort();
  }
});
await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
page.on('pageerror', (e) => console.error('viewer error:', e.message));
page.on('requestfailed', (r) => { if (!/fonts\.|catalogue\/manifest/.test(r.url())) console.error('failed to load:', r.url()); });
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto(base);
await page.waitForFunction(() => window.ringViewer, null, { timeout: 120_000 });

const combos = await page.evaluate(() => window.ringViewer.combos());
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
mkdirSync(join(outDir, 'catalogue'), { recursive: true });
const manifest = [];
const started = Date.now();
for (const combo of combos) {
  for (const metal of metals) {
    for (const stone of stones) {
      const t = Date.now();
      await page.evaluate((c) => window.ringViewer.show(c), { head: combo.head, shank: combo.shank, metal, stone, accent: 'diamond' });
      if (quality === 'photo') await page.evaluate((n) => window.ringViewer.photo(n), samples);
      const png = await page.evaluate(() => window.ringViewer.capture());
      const file = `${slug(combo.headLabel)}-on-${slug(combo.shankLabel)}-${metal}-${stone}.png`;
      writeFileSync(join(outDir, 'catalogue', file), Buffer.from(png.split(',')[1], 'base64'));
      manifest.push({ file, head: combo.head, shank: combo.shank, headLabel: combo.headLabel, shankLabel: combo.shankLabel, metal, stone, quality });
      console.log(`${file} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    }
  }
}
writeFileSync(join(outDir, 'catalogue', 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`${manifest.length} images in ${((Date.now() - started) / 1000).toFixed(0)} s`);
await browser.close();
server.close();
