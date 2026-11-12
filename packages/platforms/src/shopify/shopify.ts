/**
 * Shopify.
 *
 * Checkout: a storefront cart cannot carry an arbitrary price, so the bundle is
 * created as a draft order with one custom line item; the shopper pays through
 * the draft order's invoice URL. Line-item custom attributes come back on the
 * resulting order as `properties`.
 *
 * Webhook: subscribe to `orders/paid`. Signed with HMAC-SHA256 over the raw
 * body, base64, in X-Shopify-Hmac-Sha256.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  BUNDLE_ID_PROPERTY,
  PlatformError,
  header,
  requestJson,
  type CheckoutLineItem,
  type CreatedCheckout,
  type HttpOptions,
  type NormalizedOrder,
  type PlatformConnector,
  type WebhookHeaders,
} from '../types';

export interface ShopifyCredentials {
  /** e.g. example.myshopify.com */
  shopDomain: string;
  /** Admin API access token with write_draft_orders. */
  accessToken: string;
  /** Admin API version. Shopify serves the oldest supported version if this one has been retired. */
  apiVersion?: string;
}

const DEFAULT_API_VERSION = '2026-07';

const DRAFT_ORDER_CREATE = `
  mutation CreateBundleDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id invoiceUrl }
      userErrors { field message }
    }
  }`;

interface DraftOrderCreateResponse {
  data?: {
    draftOrderCreate?: {
      draftOrder: { id: string; invoiceUrl: string | null } | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  };
  errors?: { message: string }[];
}

export class ShopifyConnector implements PlatformConnector {
  readonly platform = 'SHOPIFY' as const;

  constructor(
    private readonly credentials: ShopifyCredentials,
    private readonly http: HttpOptions = {},
  ) {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(credentials.shopDomain)) {
      throw new PlatformError('SHOPIFY', 'shopDomain must be a *.myshopify.com hostname');
    }
  }

  async createCheckout(item: CheckoutLineItem): Promise<CreatedCheckout> {
    const { shopDomain, accessToken, apiVersion = DEFAULT_API_VERSION } = this.credentials;
    const customAttributes = [
      ...Object.entries(item.properties).map(([key, value]) => ({ key, value })),
      { key: BUNDLE_ID_PROPERTY, value: item.bundleId },
    ];

    const body = await requestJson<DraftOrderCreateResponse>(
      'SHOPIFY',
      `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: { 'x-shopify-access-token': accessToken },
        body: {
          query: DRAFT_ORDER_CREATE,
          variables: {
            input: {
              presentmentCurrencyCode: item.currency,
              tags: ['ring-builder'],
              lineItems: [
                {
                  title: item.title,
                  sku: item.sku,
                  quantity: 1,
                  originalUnitPrice: item.amount,
                  requiresShipping: true,
                  taxable: true,
                  customAttributes,
                },
              ],
            },
          },
        },
      },
      this.http,
    );

    if (body.errors?.length) {
      throw new PlatformError('SHOPIFY', body.errors.map((e) => e.message).join('; '));
    }
    const result = body.data?.draftOrderCreate;
    if (result?.userErrors.length) {
      throw new PlatformError('SHOPIFY', result.userErrors.map((e) => e.message).join('; '));
    }
    const draft = result?.draftOrder;
    if (!draft?.invoiceUrl) throw new PlatformError('SHOPIFY', 'draft order was created without an invoice URL');
    return { checkoutUrl: draft.invoiceUrl, externalCheckoutId: draft.id };
  }
}

export function verifyShopifyWebhook(rawBody: Buffer, headers: WebhookHeaders, secret: string): boolean {
  const given = header(headers, 'x-shopify-hmac-sha256');
  if (!given) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(given, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

interface ShopifyOrderPayload {
  id?: number | string;
  name?: string;
  currency?: string;
  financial_status?: string;
  customer?: { id?: number | string } | null;
  line_items?: {
    id?: number | string;
    price?: string;
    quantity?: number;
    properties?: { name?: string; value?: unknown }[] | null;
  }[];
}

export function parseShopifyOrder(rawBody: Buffer, headers: WebhookHeaders): NormalizedOrder | null {
  const order = JSON.parse(rawBody.toString('utf8')) as ShopifyOrderPayload;
  if (order.id === undefined || order.id === null) return null;
  const topic = header(headers, 'x-shopify-topic');
  return {
    platform: 'SHOPIFY',
    externalOrderId: String(order.id),
    orderNumber: order.name ?? null,
    externalCheckoutId: null, // an order does not name the draft it came from
    currency: order.currency ?? null,
    paid: topic === 'orders/paid' || order.financial_status === 'paid',
    customerReference: order.customer?.id != null ? String(order.customer.id) : null,
    lines: (order.line_items ?? []).map((li) => {
      const bundle = (li.properties ?? []).find((p) => p.name === BUNDLE_ID_PROPERTY);
      return {
        externalLineItemId: String(li.id ?? ''),
        unitPrice: li.price ?? '0',
        quantity: li.quantity ?? 1,
        bundleId: bundle?.value != null ? String(bundle.value) : null,
      };
    }),
  };
}
