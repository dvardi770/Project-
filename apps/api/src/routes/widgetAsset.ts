/**
 * GET /widget/jewelry-configurator.js — the built widget script.
 *
 * Lets a small deployment serve the widget from the API itself; larger ones
 * put the same file on a CDN and set WIDGET_SCRIPT_URL.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../common/context';

export const WIDGET_SCRIPT_PATH = '/widget/jewelry-configurator.js';
const DEFAULT_BUNDLE = fileURLToPath(new URL('../../../widget/dist/jewelry-configurator.js', import.meta.url));

export async function widgetAssetRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const path = deps.config.widgetBundlePath ?? DEFAULT_BUNDLE;
  let cached: { mtimeMs: number; body: Buffer; etag: string } | null = null;

  /** Re-read only when the file on disk changes, so a redeployed build is picked up. */
  async function load() {
    const { mtimeMs } = await stat(path);
    if (!cached || cached.mtimeMs !== mtimeMs) {
      const body = await readFile(path);
      cached = { mtimeMs, body, etag: `"${createHash('sha1').update(body).digest('hex')}"` };
    }
    return cached;
  }

  app.get(WIDGET_SCRIPT_PATH, async (request, reply) => {
    let asset;
    try {
      asset = await load();
    } catch {
      request.log.error({ path }, 'widget bundle not found; run `pnpm --filter @jewelry/widget build`');
      return reply.status(404).type('text/plain').send('Widget script has not been built.');
    }
    reply
      .header('etag', asset.etag)
      // Short, so a new build reaches stores quickly; the ETag keeps repeat loads cheap.
      .header('cache-control', 'public, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'cross-origin');
    if (request.headers['if-none-match'] === asset.etag) return reply.status(304).send();
    return reply.type('text/javascript; charset=utf-8').send(asset.body);
  });
}
