/**
 * GET /renders/* — rendered photos, 360° videos and the live 3D viewer (RENDERS_DIR).
 *
 * Public: these are product pictures, like any store's. Small deployments serve them from here;
 * larger ones put the folder on a CDN and set RENDERS_PUBLIC_URL. Supports byte ranges, which
 * Safari needs to play video.
 */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../common/context';

export const RENDERS_PATH = '/renders';

const TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  // The 3D viewer's engine (ES modules).
  '.mjs': 'text/javascript; charset=utf-8',
};

export async function renderRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const dir = deps.config.rendersDir;
  if (!dir) return;
  const root = resolve(dir);

  app.get(`${RENDERS_PATH}/*`, async (request, reply) => {
    const rel = decodeURIComponent((request.params as { '*': string })['*'] ?? '');
    const path = resolve(root, rel);
    const type = TYPES[extname(path).toLowerCase()];
    // Only known file types, and nothing outside the folder (no "..", no hidden files).
    if (!type || !path.startsWith(root + sep) || rel.split('/').some((p) => p.startsWith('.'))) {
      return reply.status(404).type('text/plain').send('Not found');
    }
    let info;
    try {
      info = await stat(path);
      if (!info.isFile()) throw new Error('not a file');
    } catch {
      return reply.status(404).type('text/plain').send('Not found');
    }

    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    reply
      .header('etag', etag)
      // Manifests and pages change when a collection is re-rendered; photos and video rarely do.
      .header('cache-control', /\.(json|html|txt|mjs)$/.test(path) ? 'public, max-age=300' : 'public, max-age=86400')
      .header('accept-ranges', 'bytes')
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'cross-origin')
      .type(type);
    if (request.headers['if-none-match'] === etag) return reply.status(304).send();

    // The 3D viewer is written as a page body (the artifact host adds the document around it).
    if (path.endsWith('.html')) {
      const body = await readFile(path, 'utf8');
      return reply.send(/^\s*<!doctype/i.test(body) ? body
        : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`);
    }

    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : info.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : info.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, info.size - 1);
      if (start > end) return reply.status(416).header('content-range', `bytes */${info.size}`).send();
      return reply
        .status(206)
        .header('content-range', `bytes ${start}-${end}/${info.size}`)
        .header('content-length', end - start + 1)
        .send(createReadStream(path, { start, end }));
    }
    return reply.header('content-length', info.size).send(createReadStream(path));
  });
}
