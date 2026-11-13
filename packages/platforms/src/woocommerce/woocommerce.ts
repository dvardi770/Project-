/**
 * WooCommerce.
 *
 * Checkout: the bundle is created as a pending order through the REST API,
 * with one line item whose total is overridden to the bundle price. Woo line
 * items must reference a product, so each store needs one hidden placeholder
 * product ("Custom Ring"). The shopper pays on the order-pay page.
 *
 * Native cart: a hidden one-off product is created at the bundle price; the
 * widget adds it through WooCommerce's own add-to-cart AJAX endpoint. The paid
 * order line is matched back by that product's id.
 *
 * Webhook: subscribe to "Order updated". Signed with HMAC-SHA256 over the raw
 * body, base64, in X-WC-Webhook-Signature. An order counts as paid once its
 * status is processing or completed.
 *
 * Writable fields, `payment_url`, the webhook signature and the add-to-cart
 * AJAX contract were checked against WooCommerce's source.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  BUNDLE_ID_PROPERTY,
  PlatformError,
  header,
  requestJson,
  type CheckoutLineItem,
  type CreatedCartItem,
  type CreatedCheckout,
  type HttpOptions,
  type NormalizedOrder,
  type PlatformConnector,
  type WebhookHeaders,
} from '../types';

export interface WooCommerceCredentials {
  /** e.g. https://shop.example.com — must be https, keys are sent with Basic auth. */
  siteUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /** Id of the hidden placeholder product that custom rings are sold as. */
  placeholderProductId: number;
}

interface WooOrderResponse {
  id: number;
  order_key?: string;
  payment_url?: string;
}

export class WooCommerceConnector implements PlatformConnector {
  readonly platform = 'WOOCOMMERCE' as const;
  private readonly base: string;

  constructor(
    private readonly credentials: WooCommerceCredentials,
    private readonly http: HttpOptions = {},
  ) {
    const url = new URL(credentials.siteUrl);
    if (url.protocol !== 'https:') throw new PlatformError('WOOCOMMERCE', 'siteUrl must use https');
    this.base = url.origin + url.pathname.replace(/\/$/, '');
    if (!Number.isInteger(credentials.placeholderProductId) || credentials.placeholderProductId <= 0) {
      throw new PlatformError('WOOCOMMERCE', 'placeholderProductId is required');
    }
  }

  async createCheckout(item: CheckoutLineItem): Promise<CreatedCheckout> {
    const { consumerKey, consumerSecret, placeholderProductId } = this.credentials;
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    const order = await requestJson<WooOrderResponse>(
      'WOOCOMMERCE',
      `${this.base}/wp-json/wc/v3/orders`,
      {
        method: 'POST',
        headers: { authorization: `Basic ${auth}` },
        body: {
          status: 'pending',
          currency: item.currency,
          created_via: 'ring-builder',
          meta_data: [{ key: BUNDLE_ID_PROPERTY, value: item.bundleId }],
          line_items: [
            {
              product_id: placeholderProductId,
              name: item.title,
              quantity: 1,
              subtotal: item.amount,
              total: item.amount,
              meta_data: [
                ...Object.entries(item.properties).map(([key, value]) => ({ key, value })),
                { key: BUNDLE_ID_PROPERTY, value: item.bundleId },
              ],
            },
          ],
        },
      },
      this.http,
    );

    if (!order.id) throw new PlatformError('WOOCOMMERCE', 'order was created without an id');
    const checkoutUrl =
      order.payment_url ??
      `${this.base}/checkout/order-pay/${order.id}/?pay_for_order=true&key=${encodeURIComponent(order.order_key ?? '')}`;
    return { checkoutUrl, externalCheckoutId: String(order.id) };
  }

  async createCartItem(item: CheckoutLineItem): Promise<CreatedCartItem> {
    const { consumerKey, consumerSecret } = this.credentials;
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const description = Object.entries(item.properties)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');

    const product = await requestJson<{ id?: number }>(
      'WOOCOMMERCE',
      `${this.base}/wp-json/wc/v3/products`,
      {
        method: 'POST',
        headers: { authorization: `Basic ${auth}` },
        body: {
          name: item.title,
          type: 'simple',
          status: 'publish',
          catalog_visibility: 'hidden',
          regular_price: item.amount,
          sku: `${item.sku}-${item.bundleId.slice(0, 8)}`,
          short_description: description,
          sold_individually: true,
          manage_stock: true,
          stock_quantity: 1,
          meta_data: [{ key: BUNDLE_ID_PROPERTY, value: item.bundleId }],
          ...(item.imageUrl ? { images: [{ src: item.imageUrl }] } : {}),
        },
      },
      this.http,
    );
    if (!product.id) throw new PlatformError('WOOCOMMERCE', 'product was created without an id');
    return { purchasableId: String(product.id), productId: String(product.id) };
  }

  async deleteCartItem(productId: string): Promise<void> {
    const { consumerKey, consumerSecret } = this.credentials;
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    try {
      await requestJson<unknown>(
        'WOOCOMMERCE',
        `${this.base}/wp-json/wc/v3/products/${encodeURIComponent(productId)}?force=true`,
        { method: 'DELETE', headers: { authorization: `Basic ${auth}` } },
        this.http,
      );
    } catch (err) {
      // Already deleted is fine.
      if (!(err instanceof PlatformError && (err.status === 404 || err.status === 410))) throw err;
    }
  }
}

export function verifyWooCommerceWebhook(rawBody: Buffer, headers: WebhookHeaders, secret: string): boolean {
  const given = header(headers, 'x-wc-webhook-signature');
  if (!given) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(given, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

interface WooOrderPayload {
  id?: number;
  number?: string;
  status?: string;
  currency?: string;
  customer_id?: number;
  line_items?: {
    id?: number;
    product_id?: number;
    quantity?: number;
    price?: number | string;
    total?: string;
    meta_data?: { key?: string; value?: unknown }[];
  }[];
}

export function parseWooCommerceOrder(rawBody: Buffer): NormalizedOrder | null {
  const order = JSON.parse(rawBody.toString('utf8')) as WooOrderPayload;
  if (!order.id) return null; // Woo sends a body without an order when a webhook is first saved
  return {
    platform: 'WOOCOMMERCE',
    externalOrderId: String(order.id),
    orderNumber: order.number ?? null,
    externalCheckoutId: String(order.id), // the order we pre-created is the order that gets paid
    currency: order.currency ?? null,
    paid: order.status === 'processing' || order.status === 'completed',
    customerReference: order.customer_id ? String(order.customer_id) : null,
    lines: (order.line_items ?? []).map((li) => {
      const quantity = li.quantity || 1;
      const bundle = (li.meta_data ?? []).find((m) => m.key === BUNDLE_ID_PROPERTY);
      const unit = li.total !== undefined ? (Number(li.total) / quantity).toFixed(2) : String(li.price ?? '0');
      return {
        externalLineItemId: String(li.id ?? ''),
        purchasableId: li.product_id ? String(li.product_id) : null,
        unitPrice: unit,
        quantity,
        bundleId: bundle?.value != null ? String(bundle.value) : null,
      };
    }),
  };
}
