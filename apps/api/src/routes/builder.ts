/**
 * GET /builder/ring-builder.html, /builder/band-builder.html and their engine (/builder/engine/*.mjs):
 * the 3D builders, served by the API so a store can show them in a frame (the WordPress plugin's
 * [jewelry_ring_builder] and [jewelry_band_builder]) without hosting them anywhere else.
 * Only these files are served; nothing else in the folder.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../common/context';

const PAGES = new Set(['ring-builder.html', 'band-builder.html']);

export async function builderRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const dir = deps.config.builderDir;
  let engineFiles: Set<string> | null = null;
  const engine = async () => (engineFiles ??= new Set((await readdir(join(dir, 'engine')).catch(() => [])).filter((f) => f.endsWith('.mjs'))));

  const headers = { 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'cross-origin' };

  app.get('/builder/:page', async (request, reply) => {
    const { page } = request.params as { page: string };
    if (!PAGES.has(page)) return reply.status(404).type('text/plain').send('Not found.');
    let body: string;
    try {
      body = await readFile(join(dir, page), 'utf8');
    } catch {
      return reply.status(404).type('text/plain').send('The builders are not installed on this server.');
    }
    // The pages are written as fragments (the artifact host wraps them); make a whole document.
    if (!/^\s*<!doctype/i.test(body)) {
      body = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
    }
    return reply.headers(headers).type('text/html; charset=utf-8').send(body);
  });

  app.get('/builder/engine/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    if (!(await engine()).has(file)) return reply.status(404).type('text/plain').send('Not found.');
    return reply.headers({ ...headers, 'access-control-allow-origin': '*' }).type('text/javascript; charset=utf-8').send(await readFile(join(dir, 'engine', file)));
  });
}
