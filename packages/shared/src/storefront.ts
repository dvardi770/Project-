/**
 * The storefront API contract: what the public endpoints return, as the widget
 * consumes it. This file has no imports so it can be used from the browser.
 *
 * The API checks its own response types against these at compile time
 * (apps/api/src/contract.ts), so the two cannot drift apart silently.
 */

export interface Money {
  amount: string;
  currency: string;
}

export interface SettingVariant {
  id: string;
  metal: string;
  metalWeightGrams: number | null;
  video360Url: string | null;
  imageUrls: string[];
  price: Money;
}

export interface Setting {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  style: string;
  compatibleShapes: string[];
  centerCarat: { min: number; max: number };
  ringSize: { min: number | null; max: number | null };
  leadTimeDays: number | null;
  video360Url: string | null;
  thumbnailUrl: string | null;
  sideStones: { shape: string; quantity: number; totalCarat: number }[];
  variants: SettingVariant[];
  priceFrom: Money;
  /** Rendered photos, 360° video and live 3D, when the setting has been rendered. */
  renders: RenderSet | null;
}

/** Where a setting's rendered media lives (made by apps/ring-lab). */
export interface RenderSet {
  /** Absolute URL of the render collection. The media manifest is `${baseUrl}/media/manifest.json`. */
  baseUrl: string;
  /** This setting's entry in the manifest's `combos` (its `id`). */
  combo: string;
  /**
   * The live 3D viewer page (the same engine as the photos and video). Options go in the query:
   * `?embed&combo=…&metal=…&shape=…&colour=…&rotate=1`.
   */
  viewerUrl: string;
}

/** media/manifest.json in a render collection, as apps/ring-lab/src/renderMedia.mjs writes it. */
export interface RenderManifest {
  version: 1;
  imageSize: number;
  halfSize: number;
  views: { id: string; label: string }[];
  metals: Record<string, { label: string; swatch: string }>;
  colours: Record<string, { label: string; swatch: string }>;
  shapes: Record<string, { label: string }>;
  combos: {
    id: string;
    /** A ring from the jeweller's CAD files (head and shank: indices into rings.json), or a design made from measurements. */
    kind?: 'cad' | 'design';
    head?: number;
    shank?: number;
    /** For designs: the ring builder's options (head, shank, shape, carat…). */
    design?: Record<string, unknown>;
    label?: string;
    headLabel: string;
    shankLabel: string;
    designedShape: string;
    /**
     * Keyed `${metal}.${shape}.${colour}`. Files: `${baseUrl}/media/${dir}/${view}.webp` and `${view}-half.webp`,
     * `video` (the ring lying down, turning once) and `poster` (its first frame).
     */
    variants: Record<string, { metal: string; shape: string; colour: string; dir: string; views: string[]; video: string | null; poster?: string | null }>;
  }[];
}

export interface Diamond {
  id: string;
  inventory: 'FEED' | 'MERCHANT';
  origin: 'NATURAL' | 'LAB_GROWN';
  shape: string;
  carat: number;
  color: string | null;
  clarity: string | null;
  cut: string | null;
  polish: string | null;
  symmetry: string | null;
  fluorescence: string | null;
  lab: string;
  certificateNumber: string | null;
  certificateUrl: string | null;
  measurements: { lengthMm: number | null; widthMm: number | null; depthMm: number | null; lwRatio: number | null };
  imageUrl: string | null;
  videoUrl: string | null;
  deliveryDays: number | null;
  price: Money;
}

export interface Page<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalCapped?: boolean;
  hasMore: boolean;
}

export interface Bundle {
  bundleId: string;
  expiresAt: number;
  token: string;
  lineItem: { title: string; sku: string; price: Money; imageUrl: string | null; properties: Record<string, string> };
}

export interface CartItem {
  bundleId: string;
  platform: 'SHOPIFY' | 'WOOCOMMERCE' | 'WIX' | 'CUSTOM';
  purchasableId: string;
  quantity: number;
  properties: Record<string, string>;
}

export interface Checkout {
  bundleId: string;
  checkoutUrl: string;
}
