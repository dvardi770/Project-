/**
 * Opens the viewer in headless Chromium for the catalogue and media renderers.
 *
 * Serves <dir> (what convert.mjs wrote, viewer included) on a local port and serves the
 * viewer's libraries from this package's node_modules instead of the CDN, so versions match
 * and no internet access is needed. Chromium comes from Playwright (`npx playwright install
 * chromium` on a new machine). It renders in software by default, which works anywhere but is
 * slow; on a machine with a GPU, set RING_LAB_CHROMIUM_ARGS to flags that enable it.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const TYPES = {
  '.html': 'text/html', '.mjs': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain', '.png': 'image/png',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4',
};
// pnpm links this package's dependencies here.
const modules = fileURLToPath(new URL('../node_modules/', import.meta.url));

/**
 * @param {string} dir output folder of convert.mjs
 * @param {{ width: number, height: number, query?: string }} viewport CSS pixels; the canvas fills it in embed mode
 */
export async function openViewer(dir, { width, height, query = '?embed&studio=white', page: pageName = '', ready = () => window.ringViewer }) {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    let path = decodeURIComponent(req.url.split('?')[0]);
    if (path === '/') path = '/index.html';
    const file = join(root, path);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) return res.writeHead(404).end();
    let body = readFileSync(file);
    // The artifact host wraps the page in a document; do the same here.
    if (file.endsWith('.html')) body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`;
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const browser = await chromium.launch({
    args: (process.env.RING_LAB_CHROMIUM_ARGS ?? '--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist').split(' ').filter(Boolean),
  });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/(.+?)@[^/]+\/(.*)$/, (route) => {
    const [, name, file] = route.request().url().match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/(.+?)@[^/]+\/(.*)$/);
    try {
      route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(join(modules, name, file)) });
    } catch {
      route.abort();
    }
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  page.on('pageerror', (e) => console.error('viewer error:', e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`http://127.0.0.1:${server.address().port}/${pageName}${query}`);
  await page.waitForFunction(ready, null, { timeout: 180_000 });
  return {
    page,
    async close() { await browser.close(); server.close(); },
  };
}

/** Command-line options: `--name value` pairs after the positional arguments. */
export function options(args) {
  return (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
}

/** A data URL's bytes. */
export const bytesOf = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

/** Lower-case, dash-separated, ASCII. */
export const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
