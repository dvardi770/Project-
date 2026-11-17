/**
 * Hand-off to the host storefront's own cart.
 *
 * The API has already created a one-off product priced at the bundle total;
 * these functions add it with the platform's native call so the theme's cart,
 * drawer and checkout behave exactly as for any other product.
 */

export type StorefrontPlatform = 'SHOPIFY' | 'WOOCOMMERCE' | 'UNKNOWN';

/** The globals each platform's storefront JavaScript exposes. */
interface StorefrontWindow {
  Shopify?: { shop?: string; routes?: { root?: string } };
  wc_add_to_cart_params?: { wc_ajax_url?: string; cart_url?: string };
  woocommerce_params?: { wc_ajax_url?: string };
  wc_cart_fragments_params?: { wc_ajax_url?: string };
  jQuery?: (target: unknown) => { trigger: (event: string, args?: unknown[]) => void };
  document: Pick<Document, 'body' | 'querySelector' | 'dispatchEvent'>;
  location: Pick<Location, 'origin'>;
  fetch: typeof fetch;
}

const asStorefront = (win: unknown) => win as StorefrontWindow;

export function detectPlatform(win: unknown = window): StorefrontPlatform {
  const w = asStorefront(win);
  if (w.Shopify && (w.Shopify.shop || w.Shopify.routes)) return 'SHOPIFY';
  if (
    w.wc_add_to_cart_params ||
    w.woocommerce_params ||
    w.wc_cart_fragments_params ||
    w.document.body?.classList.contains('woocommerce') ||
    w.document.body?.classList.contains('woocommerce-page') ||
    w.document.querySelector('meta[name="generator"][content^="WooCommerce"]')
  ) {
    return 'WOOCOMMERCE';
  }
  return 'UNKNOWN';
}

export class CartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CartError';
  }
}

export interface CartResult {
  /** Where the shopper can see their cart. */
  cartUrl: string;
}

/** POST {root}cart/add.js with the variant and its line-item properties. */
export async function addToShopifyCart(
  item: { variantId: string; properties: Record<string, string> },
  win: unknown = window,
): Promise<CartResult> {
  const w = asStorefront(win);
  // routes.root carries the locale prefix on multi-language stores, e.g. "/fr/".
  const root = w.Shopify?.routes?.root ?? '/';
  const response = await w.fetch(`${root}cart/add.js`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ items: [{ id: Number(item.variantId), quantity: 1, properties: item.properties }] }),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { description?: string; message?: string } | null;
    throw new CartError(detail?.description ?? detail?.message ?? `Shopify cart responded with ${response.status}`);
  }
  // Themes listen for different events; this one is ours and documented.
  w.document.dispatchEvent(new CustomEvent('jewelry-configurator:cart-updated', { detail: { platform: 'SHOPIFY' } }));
  return { cartUrl: `${root}cart` };
}

/** POST ?wc-ajax=add_to_cart, then let WooCommerce refresh its cart fragments. */
export async function addToWooCommerceCart(item: { productId: string }, win: unknown = window): Promise<CartResult> {
  const w = asStorefront(win);
  const template =
    w.wc_add_to_cart_params?.wc_ajax_url ?? w.woocommerce_params?.wc_ajax_url ?? w.wc_cart_fragments_params?.wc_ajax_url ?? '/?wc-ajax=%%endpoint%%';
  const response = await w.fetch(template.replace('%%endpoint%%', 'add_to_cart'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', accept: 'application/json' },
    body: new URLSearchParams({ product_id: item.productId, quantity: '1' }).toString(),
  });
  const result = (await response.json().catch(() => null)) as {
    error?: boolean;
    fragments?: Record<string, string>;
    cart_hash?: string;
  } | null;
  if (!response.ok || !result || result.error) {
    throw new CartError('WooCommerce could not add the ring to the cart');
  }
  // The same event WooCommerce's own buttons fire: updates the mini-cart.
  w.jQuery?.(w.document.body).trigger('added_to_cart', [result.fragments, result.cart_hash, null]);
  w.document.dispatchEvent(new CustomEvent('jewelry-configurator:cart-updated', { detail: { platform: 'WOOCOMMERCE' } }));
  return { cartUrl: w.wc_add_to_cart_params?.cart_url ?? '/cart/' };
}
