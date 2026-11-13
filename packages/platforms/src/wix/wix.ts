/**
 * Wix.
 *
 * Checkout: an eCommerce checkout is created with one custom line item, then
 * its hosted checkout URL is requested. Wix shows every description line to
 * the shopper, so the bundle id is not put on the line; the resulting order is
 * matched back through its checkoutId instead.
 *
 * Webhook: subscribe the Wix app to the eCommerce "Order Approved" event. Wix
 * delivers a JWT signed (RS256) with the app's key; the "secret" used to
 * verify it is the app's public key in PEM form.
 *
 * Endpoints, request fields and the webhook envelope were checked against
 * Wix's SDK packages (@wix/auto_sdk_ecom_checkout, _orders, @wix/sdk).
 */
import { createVerify } from 'node:crypto';
import {
  PlatformError,
  requestJson,
  type CheckoutLineItem,
  type CreatedCheckout,
  type HttpOptions,
  type NormalizedOrder,
  type PlatformConnector,
} from '../types';

export interface WixCredentials {
  /** Account-level API key with eCommerce permissions. */
  apiKey: string;
  siteId: string;
}

const API = 'https://www.wixapis.com';

export class WixConnector implements PlatformConnector {
  readonly platform = 'WIX' as const;

  constructor(
    private readonly credentials: WixCredentials,
    private readonly http: HttpOptions = {},
  ) {}

  async createCheckout(item: CheckoutLineItem): Promise<CreatedCheckout> {
    const headers = { authorization: this.credentials.apiKey, 'wix-site-id': this.credentials.siteId };

    const created = await requestJson<{ checkout?: { id?: string } }>(
      'WIX',
      `${API}/ecom/v1/checkouts`,
      {
        method: 'POST',
        headers,
        body: {
          channelType: 'OTHER_PLATFORM',
          customLineItems: [
            {
              quantity: 1,
              fixedQuantity: true, // a bundle is one ring
              price: item.amount,
              productName: { original: item.title },
              itemType: { preset: 'PHYSICAL' },
              physicalProperties: { sku: item.sku, shippable: true },
              descriptionLines: Object.entries(item.properties).map(([name, value]) => ({
                name: { original: name },
                plainText: { original: value },
              })),
            },
          ],
        },
      },
      this.http,
    );
    const checkoutId = created.checkout?.id;
    if (!checkoutId) throw new PlatformError('WIX', 'checkout was created without an id');

    const link = await requestJson<{ checkoutUrl?: string }>(
      'WIX',
      `${API}/ecom/v1/checkouts/${encodeURIComponent(checkoutId)}/checkout-url`,
      { method: 'GET', headers },
      this.http,
    );
    if (!link.checkoutUrl) throw new PlatformError('WIX', 'no checkout URL returned');
    return { checkoutUrl: link.checkoutUrl, externalCheckoutId: checkoutId };
  }
}

/** Verify the RS256 signature of a Wix webhook JWT and return its payload, or null. */
export function verifyWixWebhook(
  rawBody: Buffer,
  publicKeyPem: string,
  now = Date.now(),
): Record<string, unknown> | null {
  const token = rawBody.toString('utf8').trim();
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, payload, signature] = parts as [string, string, string];
  try {
    const { alg } = JSON.parse(Buffer.from(head, 'base64url').toString()) as { alg?: string };
    if (alg !== 'RS256') return null; // never let the token choose a weaker algorithm
    const ok = createVerify('RSA-SHA256')
      .update(`${head}.${payload}`)
      .verify(publicKeyPem, Buffer.from(signature, 'base64url'));
    if (!ok) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
    if (typeof claims.exp === 'number' && claims.exp * 1000 < now) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Wix nests JSON-encoded strings inside the JWT payload; unwrap until an object appears. */
function unwrap(value: unknown): Record<string, unknown> | null {
  let current = value;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current === 'string') {
      try {
        current = JSON.parse(current);
      } catch {
        return null;
      }
    } else if (current && typeof current === 'object' && 'data' in current) {
      const inner = (current as { data: unknown }).data;
      if (typeof inner === 'string' || (inner && typeof inner === 'object' && 'data' in inner)) current = inner;
      else return current as Record<string, unknown>;
    } else {
      break;
    }
  }
  return current && typeof current === 'object' ? (current as Record<string, unknown>) : null;
}

interface WixOrder {
  id?: string;
  number?: string | number;
  checkoutId?: string;
  currency?: string;
  paymentStatus?: string;
  buyerInfo?: { contactId?: string };
  lineItems?: { id?: string; quantity?: number; price?: { amount?: string } }[];
}

export function parseWixOrder(jwtPayload: Record<string, unknown>): NormalizedOrder | null {
  const event = unwrap(jwtPayload) as {
    actionEvent?: { body?: { order?: WixOrder } };
    createdEvent?: { entity?: WixOrder };
    updatedEvent?: { currentEntity?: WixOrder };
    order?: WixOrder;
  } | null;
  const order =
    event?.actionEvent?.body?.order ?? event?.createdEvent?.entity ?? event?.updatedEvent?.currentEntity ?? event?.order;
  if (!order?.id) return null;
  return {
    platform: 'WIX',
    externalOrderId: order.id,
    orderNumber: order.number != null ? String(order.number) : null,
    externalCheckoutId: order.checkoutId ?? null,
    currency: order.currency ?? null,
    paid: order.paymentStatus === 'PAID',
    customerReference: order.buyerInfo?.contactId ?? null,
    lines: (order.lineItems ?? []).map((li) => ({
      externalLineItemId: li.id ?? '',
      purchasableId: null,
      unitPrice: li.price?.amount ?? '0',
      quantity: li.quantity ?? 1,
      bundleId: null,
    })),
  };
}
