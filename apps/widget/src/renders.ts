/**
 * Rendered photos, 360° video and live 3D for a setting (made by apps/ring-lab).
 *
 * The API says where a setting's renders are (Setting.renders); the list of what was rendered
 * is the collection's media/manifest.json, fetched once per collection.
 */
import type { RenderManifest, RenderSet } from '@jewelry/shared/storefront';

const manifests = new Map<string, Promise<RenderManifest | null>>();

export function loadRenderManifest(set: RenderSet): Promise<RenderManifest | null> {
  let pending = manifests.get(set.baseUrl);
  if (!pending) {
    pending = fetch(`${set.baseUrl}/media/manifest.json`, { credentials: 'omit' })
      .then((r) => (r.ok ? (r.json() as Promise<RenderManifest>) : null))
      .catch(() => null);
    manifests.set(set.baseUrl, pending);
  }
  return pending;
}

/** The render manifest's metal for a stocked metal. Palladium and silver look like white metal. */
export function renderMetal(metal: string, available: string[]): string | null {
  const want = metal.startsWith('YELLOW') ? 'yellow' : metal.startsWith('ROSE') ? 'rose' : metal.startsWith('PLATINUM') ? 'platinum' : 'white';
  if (available.includes(want)) return want;
  return want === 'platinum' && available.includes('white') ? 'white' : null;
}

/** Viewer stones for the manifest's diamond colours. */
const STONE_FOR_COLOUR: Record<string, string> = { white: 'diamond', yellow: 'yellow', pink: 'pinkdiamond', blue: 'bluediamond' };

export interface RenderedRing {
  /** Folder of this variant's files. */
  base: string;
  views: { id: string; label: string }[];
  video: string | null;
  /** First frame of the video, shown while it loads. */
  poster: string;
  /** Live 3D viewer for the same choices. */
  viewer: string;
  /** Shape the photos show, and whether it is the customer's diamond's shape. */
  shape: string;
  shapeLabel: string;
  exactShape: boolean;
}

/**
 * The rendered variant closest to the customer's choices: their metal, their diamond's shape
 * when it was rendered (otherwise the setting's own shape), and a white diamond for graded stones.
 */
export function pickRendered(
  manifest: RenderManifest,
  set: RenderSet,
  metal: string,
  diamondShape: string,
  diamondColour: string | null,
): RenderedRing | null {
  const combo = manifest.combos.find((c) => c.id === set.combo);
  if (!combo) return null;
  const metalKey = renderMetal(metal, Object.keys(manifest.metals));
  if (!metalKey) return null;
  // Graded diamonds (D–M) are shown white; fancy colours are not in the diamond data yet.
  const colour = diamondColour && manifest.colours[diamondColour.toLowerCase()] ? diamondColour.toLowerCase() : 'white';
  const wanted = diamondShape.toLowerCase();
  const variants = combo.variants;
  const exact = variants[`${metalKey}.${wanted}.${colour}`] ?? null;
  const fallback = variants[`${metalKey}.${combo.designedShape}.${colour}`] ?? variants[`${metalKey}.${combo.designedShape}.white`] ?? null;
  const variant = exact ?? fallback;
  if (!variant) return null;
  const query = new URLSearchParams({
    studio: 'white', rotate: '1', head: String(combo.head), shank: String(combo.shank),
    metal: metalKey, stone: STONE_FOR_COLOUR[variant.colour] ?? 'diamond', shape: exact ? wanted : combo.designedShape,
  });
  return {
    base: `${set.baseUrl}/media/${variant.dir}`,
    views: manifest.views.filter((v) => variant.views.includes(v.id)),
    video: variant.video,
    poster: variant.poster ?? 'threequarter.webp',
    viewer: `${set.viewerUrl}?embed&${query}`,
    shape: variant.shape,
    shapeLabel: manifest.shapes[variant.shape]?.label ?? variant.shape,
    exactShape: !!exact,
  };
}
