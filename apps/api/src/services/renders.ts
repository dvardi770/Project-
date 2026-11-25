/**
 * Rendered media for settings (photos from four angles, a 360° video and live 3D), made by
 * apps/ring-lab and stored as collections under RENDERS_DIR:
 *
 *   <collection>/index.html                   the live 3D viewer
 *   <collection>/media/manifest.json          what was rendered (RenderManifest)
 *   <collection>/media/<combo>/<variant>/…    the photos and video
 *
 * A setting points at its collection and combo with renderKey "<collection>/<combo>".
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MetalType } from '@jewelry/db';
import type { RenderManifest, RenderSet } from '@jewelry/shared/storefront';

const cache = new Map<string, { mtimeMs: number; manifest: RenderManifest }>();

/** The collection's manifest, re-read only when the file changes; null when there is none. */
export async function loadManifest(rendersDir: string, collection: string): Promise<RenderManifest | null> {
  const path = join(rendersDir, collection, 'media', 'manifest.json');
  try {
    const { mtimeMs } = await stat(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.manifest;
    const manifest = JSON.parse(await readFile(path, 'utf8')) as RenderManifest;
    cache.set(path, { mtimeMs, manifest });
    return manifest;
  } catch {
    return null;
  }
}

/** The render manifest's metal for a stocked metal. Palladium and silver look like white metal. */
export function renderMetal(metal: MetalType, available: string[]): string | null {
  const want = metal.startsWith('YELLOW') ? 'yellow' : metal.startsWith('ROSE') ? 'rose' : metal.startsWith('PLATINUM') ? 'platinum' : 'white';
  if (available.includes(want)) return want;
  return want === 'platinum' && available.includes('white') ? 'white' : null;
}

export function renderSet(publicBase: string, renderKey: string): RenderSet {
  const [collection, combo] = renderKey.split('/') as [string, string];
  const baseUrl = `${publicBase}/${collection}`;
  return { baseUrl, combo, viewerUrl: `${baseUrl}/index.html` };
}

/**
 * Photo and video URLs for one metal of a rendered setting, in the setting's own stone shape with
 * a white diamond: the angled view first, as the builder's cards show the first image.
 */
export function variantMedia(
  manifest: RenderManifest,
  set: RenderSet,
  metal: MetalType,
): { imageUrls: string[]; video360Url: string | null } | null {
  const combo = manifest.combos.find((c) => c.id === set.combo);
  if (!combo) return null;
  const key = renderMetal(metal, Object.keys(manifest.metals));
  if (!key) return null;
  const colour = manifest.colours.white ? 'white' : Object.keys(manifest.colours)[0];
  const variant = combo.variants[`${key}.${combo.designedShape}.${colour}`];
  if (!variant) return null;
  const views = [...variant.views].sort((a, b) => (a === 'threequarter' ? -1 : b === 'threequarter' ? 1 : 0));
  const base = `${set.baseUrl}/media/${variant.dir}`;
  return {
    imageUrls: views.map((v) => `${base}/${v}-half.webp`),
    video360Url: variant.video ? `${base}/${variant.video}` : null,
  };
}
