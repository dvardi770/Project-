import type { PlatformType } from '@jewelry/db';
import { ShopifyConnector, parseShopifyOrder, verifyShopifyWebhook, type ShopifyCredentials } from './shopify/shopify';
import { PlatformError, type HttpOptions, type NormalizedOrder, type PlatformConnector, type WebhookHeaders } from './types';
import { WixConnector, parseWixOrder, verifyWixWebhook, type WixCredentials } from './wix/wix';
import {
  WooCommerceConnector,
  parseWooCommerceOrder,
  verifyWooCommerceWebhook,
  type WooCommerceCredentials,
} from './woocommerce/woocommerce';

export * from './types';
export * from './secretBox';
export * from './shopify/shopify';
export * from './woocommerce/woocommerce';
export * from './wix/wix';

/** Build the connector for a tenant's storefront from its decrypted credentials. */
export function createConnector(platform: PlatformType, credentials: unknown, http: HttpOptions = {}): PlatformConnector {
  switch (platform) {
    case 'SHOPIFY':
      return new ShopifyConnector(credentials as ShopifyCredentials, http);
    case 'WOOCOMMERCE':
      return new WooCommerceConnector(credentials as WooCommerceCredentials, http);
    case 'WIX':
      return new WixConnector(credentials as WixCredentials, http);
    default:
      throw new PlatformError(platform, 'no checkout connector for this platform');
  }
}

export type WebhookResult =
  | { ok: false; reason: 'bad_signature' | 'unsupported_platform' }
  | { ok: true; order: NormalizedOrder | null };

/**
 * Authenticate a storefront webhook and reduce it to a NormalizedOrder.
 * `secret` is the HMAC secret (Shopify, WooCommerce) or the app's public key
 * in PEM form (Wix). `order` is null for authentic deliveries that are not
 * orders, such as a test ping.
 */
export function receiveOrderWebhook(
  platform: PlatformType,
  rawBody: Buffer,
  headers: WebhookHeaders,
  secret: string,
): WebhookResult {
  switch (platform) {
    case 'SHOPIFY':
      if (!verifyShopifyWebhook(rawBody, headers, secret)) return { ok: false, reason: 'bad_signature' };
      return { ok: true, order: parseShopifyOrder(rawBody, headers) };
    case 'WOOCOMMERCE':
      if (!verifyWooCommerceWebhook(rawBody, headers, secret)) return { ok: false, reason: 'bad_signature' };
      return { ok: true, order: parseWooCommerceOrder(rawBody) };
    case 'WIX': {
      const payload = verifyWixWebhook(rawBody, secret);
      if (!payload) return { ok: false, reason: 'bad_signature' };
      return { ok: true, order: parseWixOrder(payload) };
    }
    default:
      return { ok: false, reason: 'unsupported_platform' };
  }
}
