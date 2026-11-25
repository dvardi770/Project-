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
      .catch(() => null)
      .then((m) => {
        // A failed load is tried again next time (a phone may simply have lost its signal).
        if (!m) manifests.delete(set.baseUrl);
        return m;
      });
    manifests.set(set.baseUrl, pending);
  }
  return pending;
}

/** The colour of a stocked metal, as the renderer names it. Palladium and silver look like white metal. */
const metalColour = (metal: string) =>
  metal.startsWith('YELLOW') ? 'yellow' : metal.startsWith('ROSE') ? 'rose' : metal.startsWith('PLATINUM') ? 'platinum' : 'white';

/** The render manifest's metal for a stocked metal. Palladium and silver look like white metal. */
export function renderMetal(metal: string, available: string[]): string | null {
  const want = metalColour(metal);
  if (available.includes(want)) return want;
  return want === 'platinum' && available.includes('white') ? 'white' : null;
}

export interface RenderedPhoto {
  id: string;
  label: string;
  /** Full size, and the smaller copy used for thumbnails and phones. */
  src: string;
  thumb: string;
  srcset: string | null;
}

/** What the review step shows: photos, a 360° turn and live 3D, each when there is one. */
export interface RenderedRing {
  photos: RenderedPhoto[];
  /** 360°: a video file, or another site's 360° viewer shown in a frame. */
  spin: { url: string; poster: string | null; video: boolean } | null;
  /** Live 3D viewer for the same choices. */
  viewer: string | null;
  /** The centre stone shape the photos show, when the renders say; null for the setting's own photos. */
  shown: { shape: string; label: string; exact: boolean } | null;
}

const VIEW_LABELS: Record<string, string> = { threequarter: 'Angled', front: 'Front', side: 'Side', top: 'Top' };
const isVideo = (url: string) => /\.(mp4|webm|mov)(\?|#|$)/i.test(url);

/**
 * The gallery from the setting's own photos and 360° when there is no render manifest (or it has
 * not loaded): each photo, the 360° and the live 3D. Null when there is only one picture and
 * nothing to switch to; the review step then shows that picture alone.
 */
export function photoGallery(images: string[], spinUrl: string | null, set: RenderSet | null, viewerUrl: string | null, metal: string): RenderedRing | null {
  const viewer = set && viewerUrl
    ? `${viewerUrl}?embed&${new URLSearchParams({ combo: set.combo, metal: metalColour(metal), rotate: '1' })}`
    : null;
  if (!images.length || (images.length < 2 && !spinUrl && !viewer)) return null;
  const photos = images.map((url, i): RenderedPhoto => {
    // The renderer's files: <view>-half.webp beside <view>.webp.
    const m = url.match(/\/([a-z]+)-half\.(webp|jpe?g|png)(\?.*)?$/i);
    if (!m || !VIEW_LABELS[m[1]!]) return { id: `photo-${i + 1}`, label: `Photo ${i + 1}`, src: url, thumb: url, srcset: null };
    const full = url.replace(`-half.${m[2]}`, `.${m[2]}`);
    return { id: m[1]!, label: VIEW_LABELS[m[1]!]!, src: full, thumb: url, srcset: `${url} 500w, ${full} 1000w` };
  });
  const poster = spinUrl?.match(/\/spin\.mp4(\?.*)?$/) ? spinUrl.replace(/spin\.mp4(\?.*)?$/, 'spin-poster.webp') : null;
  return {
    photos,
    spin: spinUrl ? { url: spinUrl, poster, video: isVideo(spinUrl) } : null,
    viewer,
    shown: null,
  };
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
  // The live 3D shows the same ring as the photos: this combo, metal, shape and colour.
  const query = new URLSearchParams({
    combo: combo.id, metal: metalKey, shape: exact ? wanted : combo.designedShape, colour: variant.colour, rotate: '1',
  });
  const base = `${set.baseUrl}/media/${variant.dir}`;
  return {
    photos: manifest.views
      .filter((v) => variant.views.includes(v.id))
      .map((v) => ({ id: v.id, label: v.label, src: `${base}/${v.id}.webp`, thumb: `${base}/${v.id}-half.webp`, srcset: `${base}/${v.id}-half.webp 500w, ${base}/${v.id}.webp 1000w` })),
    spin: variant.video ? { url: `${base}/${variant.video}`, poster: `${base}/${variant.poster ?? 'threequarter.webp'}`, video: true } : null,
    viewer: `${set.viewerUrl}?embed&${query}`,
    shown: { shape: variant.shape, label: manifest.shapes[variant.shape]?.label ?? variant.shape, exact: !!exact },
  };
}
