import type { PlatformType } from '@jewelry/db';

/** One custom-priced cart line to put through a storefront's checkout. */
export interface CheckoutLineItem {
  /** Our bundle / checkout-session id. Travels with the order so the webhook can match it. */
  bundleId: string;
  title: string;
  sku: string;
  /** Decimal string, e.g. "2600.99". */
  amount: string;
  currency: string;
  imageUrl: string | null;
  /** Shown to the shopper (setting, metal, ring size, diamond, …). */
  properties: Record<string, string>;
}

export interface CreatedCheckout {
  /** Where to send the shopper to pay. */
  checkoutUrl: string;
  /** The platform's id for what was created (draft order, order, checkout). */
  externalCheckoutId: string;
}

export interface NormalizedOrderLine {
  externalLineItemId: string;
  /** Unit price actually charged, as a decimal string. */
  unitPrice: string;
  quantity: number;
  /** Value of the hidden bundle-id property, when the platform carries it. */
  bundleId: string | null;
}

/** A storefront order reduced to what order intake needs. */
export interface NormalizedOrder {
  platform: PlatformType;
  externalOrderId: string;
  /** Human-facing order number, when there is one. */
  orderNumber: string | null;
  /** Id of the checkout / pre-created order this came from, when known. */
  externalCheckoutId: string | null;
  currency: string | null;
  paid: boolean;
  customerReference: string | null;
  lines: NormalizedOrderLine[];
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface PlatformConnector {
  readonly platform: PlatformType;
  createCheckout(item: CheckoutLineItem): Promise<CreatedCheckout>;
}

/** Line-item property that carries the bundle id. A leading "_" hides it from shoppers on Shopify and WooCommerce. */
export const BUNDLE_ID_PROPERTY = '_bundle_id';

export class PlatformError extends Error {
  constructor(
    readonly platform: PlatformType,
    message: string,
    readonly status?: number,
  ) {
    super(`${platform}: ${message}`);
    this.name = 'PlatformError';
  }
}

export interface HttpOptions {
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** JSON request with timeout; throws PlatformError on transport or HTTP failure. */
export async function requestJson<T>(
  platform: PlatformType,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: unknown },
  options: HttpOptions = {},
): Promise<T> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: init.method,
      headers: { accept: 'application/json', 'content-type': 'application/json', ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new PlatformError(platform, `request failed: ${(err as Error).message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new PlatformError(platform, `HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PlatformError(platform, 'response was not JSON', response.status);
  }
}

export function header(headers: WebhookHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
