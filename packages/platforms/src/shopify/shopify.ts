/**
 * Shopify.
 *
 * Checkout: a storefront cart cannot carry an arbitrary price, so the bundle is
 * created as a draft order with one custom line item; the shopper pays through
 * the draft order's invoice URL. Line-item custom attributes come back on the
 * resulting order as `properties`.
 *
 * Native cart: /cart/add.js can only add an existing variant at its own price,
 * so a one-off product is created at the bundle price and published to the
 * Online Store; the widget then adds that variant with the bundle's properties.
 * Needs write_products and write_publications. One-off products are tagged
 * "ring-builder-bundle" and created with the UNLISTED status.
 *
 * Mutation and input names were checked against the Admin GraphQL schema
 * (2026-07); the App Proxy and webhook signatures against @shopify/shopify-api.
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
  type CreatedCartItem,
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
  /** Publication id of the Online Store channel. Looked up by name when omitted. */
  onlineStorePublicationId?: string;
}

const DEFAULT_API_VERSION = '2026-07';

const DRAFT_ORDER_CREATE = `
  mutation CreateBundleDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id invoiceUrl }
      userErrors { field message }
    }
  }`;

// Publication.name is deprecated in favour of catalog.title; ask for both.
const PUBLICATIONS = `{ publications(first: 50) { nodes { id name catalog { title } } } }`;

const PRODUCT_SET = `
  mutation CreateBundleProduct($input: ProductSetInput!) {
    productSet(synchronous: true, input: $input) {
      product { id variants(first: 1) { nodes { id } } }
      userErrors { field message }
    }
  }`;

const PUBLISH = `
  mutation PublishBundleProduct($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }`;

const PRODUCT_DELETE = `
  mutation DeleteBundleProduct($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }`;

interface GraphQLBody<T> {
  data?: T;
  errors?: { message: string }[];
}
type UserErrors = { field: string[] | null; message: string }[];

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

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const { shopDomain, accessToken, apiVersion = DEFAULT_API_VERSION } = this.credentials;
    const body = await requestJson<GraphQLBody<T>>(
      'SHOPIFY',
      `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
      { method: 'POST', headers: { 'x-shopify-access-token': accessToken }, body: { query, variables } },
      this.http,
    );
    if (body.errors?.length) throw new PlatformError('SHOPIFY', body.errors.map((e) => e.message).join('; '));
    if (!body.data) throw new PlatformError('SHOPIFY', 'empty GraphQL response');
    return body.data;
  }

  private static check(errors: UserErrors | undefined): void {
    if (errors?.length) throw new PlatformError('SHOPIFY', errors.map((e) => e.message).join('; '));
  }

  private customAttributes(item: CheckoutLineItem) {
    return [
      ...Object.entries(item.properties).map(([key, value]) => ({ key, value })),
      { key: BUNDLE_ID_PROPERTY, value: item.bundleId },
    ];
  }

  async createCheckout(item: CheckoutLineItem): Promise<CreatedCheckout> {
    const data = await this.graphql<DraftOrderCreateResponse['data']>(DRAFT_ORDER_CREATE, {
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
            customAttributes: this.customAttributes(item),
          },
        ],
      },
    });
    ShopifyConnector.check(data?.draftOrderCreate?.userErrors);
    const draft = data?.draftOrderCreate?.draftOrder;
    if (!draft?.invoiceUrl) throw new PlatformError('SHOPIFY', 'draft order was created without an invoice URL');
    return { checkoutUrl: draft.invoiceUrl, externalCheckoutId: draft.id };
  }

  async createCartItem(item: CheckoutLineItem): Promise<CreatedCartItem> {
    let publicationId = this.credentials.onlineStorePublicationId;
    if (!publicationId) {
      const pubs = await this.graphql<{
        publications: { nodes: { id: string; name?: string | null; catalog?: { title?: string | null } | null }[] };
      }>(PUBLICATIONS);
      publicationId = pubs.publications.nodes.find(
        (p) => p.name === 'Online Store' || p.catalog?.title === 'Online Store',
      )?.id;
      if (!publicationId) throw new PlatformError('SHOPIFY', 'the store has no Online Store sales channel');
    }

    const created = await this.graphql<{
      productSet: {
        product: { id: string; variants: { nodes: { id: string }[] } } | null;
        userErrors: UserErrors;
      };
    }>(PRODUCT_SET, {
      input: {
        title: item.title,
        // Unlisted (Admin API 2025-10+): purchasable by direct reference, but kept
        // out of search, collections and recommendations.
        status: 'UNLISTED',
        vendor: 'Ring Builder',
        tags: ['ring-builder-bundle'],
        productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
        variants: [
          {
            optionValues: [{ optionName: 'Title', name: 'Default Title' }],
            price: item.amount,
            sku: `${item.sku}-${item.bundleId.slice(0, 8)}`,
            inventoryPolicy: 'CONTINUE',
          },
        ],
      },
    });
    ShopifyConnector.check(created.productSet.userErrors);
    const product = created.productSet.product;
    const variantGid = product?.variants.nodes[0]?.id;
    const variantId = variantGid?.match(/(\d+)$/)?.[1];
    if (!product || !variantId) throw new PlatformError('SHOPIFY', 'product was created without a variant');

    const published = await this.graphql<{ publishablePublish: { userErrors: UserErrors } }>(PUBLISH, {
      id: product.id,
      input: [{ publicationId }],
    });
    ShopifyConnector.check(published.publishablePublish.userErrors);
    return { purchasableId: variantId, productId: product.id };
  }

  async deleteCartItem(productId: string): Promise<void> {
    const data = await this.graphql<{ productDelete: { deletedProductId: string | null; userErrors: UserErrors } }>(
      PRODUCT_DELETE,
      { input: { id: productId } },
    );
    const errors = data.productDelete.userErrors;
    // A product someone already removed by hand is the outcome we wanted.
    if (errors.length && !errors.every((e) => /not exist|not found/i.test(e.message))) ShopifyConnector.check(errors);
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
    variant_id?: number | string | null;
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
        purchasableId: li.variant_id != null ? String(li.variant_id) : null,
        unitPrice: li.price ?? '0',
        quantity: li.quantity ?? 1,
        bundleId: bundle?.value != null ? String(bundle.value) : null,
      };
    }),
  };
}
