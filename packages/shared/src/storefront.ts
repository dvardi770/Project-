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
