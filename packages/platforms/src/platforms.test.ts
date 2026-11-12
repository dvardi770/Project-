import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  WixConnector,
  WooCommerceConnector,
  ShopifyConnector,
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
  parseEncryptionKey,
  receiveOrderWebhook,
  type CheckoutLineItem,
} from './index';

const item: CheckoutLineItem = {
  bundleId: '3f0c9b0e-58a4-4b8e-9d3c-1f2a3b4c5d6e',
  title: 'Classic Solitaire in 14K White Gold with 1.50ct Oval Diamond',
  sku: 'SOL-1-WHITE_GOLD_14K',
  amount: '2600.99',
  currency: 'USD',
  imageUrl: null,
  properties: { Metal: '14K White Gold', 'Ring size': '6.5' },
};

const reply = (...bodies: unknown[]) => {
  const mock = vi.fn();
  for (const b of bodies) mock.mockResolvedValueOnce(new Response(JSON.stringify(b), { status: 200 }));
  return mock;
};
const sent = (mock: ReturnType<typeof vi.fn>, n = 0) => ({
  url: mock.mock.calls[n]![0] as string,
  init: mock.mock.calls[n]![1] as { method: string; headers: Record<string, string>; body?: string },
  body: mock.mock.calls[n]![1].body ? JSON.parse(mock.mock.calls[n]![1].body) : undefined,
});

describe('secretBox', () => {
  const key = parseEncryptionKey('ab'.repeat(32));
  it('round-trips and uses a fresh nonce each time', () => {
    const a = encryptSecret('s3cret', key);
    expect(decryptSecret(a, key)).toBe('s3cret');
    expect(Buffer.compare(a, encryptSecret('s3cret', key))).not.toBe(0);
    expect(decryptJson(encryptJson({ a: 1 }, key), key)).toEqual({ a: 1 });
  });
  it('rejects tampering, wrong keys and bad key sizes', () => {
    const box = encryptSecret('s3cret', key);
    box[box.length - 1]! ^= 1;
    expect(() => decryptSecret(box, key)).toThrow();
    expect(() => decryptSecret(encryptSecret('x', key), parseEncryptionKey('cd'.repeat(32)))).toThrow();
    expect(() => parseEncryptionKey('short')).toThrow(/32 bytes/);
  });
});

describe('Shopify', () => {
  it('reports user errors and refuses non-Shopify hosts', async () => {
    const fetchMock = reply({ data: { draftOrderCreate: { draftOrder: null, userErrors: [{ field: null, message: 'Bad price' }] } } });
    const c = new ShopifyConnector({ shopDomain: 'x.myshopify.com', accessToken: 't' }, { fetch: fetchMock });
    await expect(c.createCheckout(item)).rejects.toThrow(/Bad price/);
    expect(() => new ShopifyConnector({ shopDomain: 'evil.example.com/x', accessToken: 't' })).toThrow();
  });
});

describe('WooCommerce', () => {
  const creds = { siteUrl: 'https://shop.example.com/', consumerKey: 'ck_1', consumerSecret: 'cs_1', placeholderProductId: 42 };

  it('creates a pending order with the price overridden', async () => {
    const fetchMock = reply({ id: 900, order_key: 'wc_order_abc' });
    const result = await new WooCommerceConnector(creds, { fetch: fetchMock }).createCheckout(item);
    const { url, init, body } = sent(fetchMock);
    expect(url).toBe('https://shop.example.com/wp-json/wc/v3/orders');
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from('ck_1:cs_1').toString('base64')}`);
    expect(body.status).toBe('pending');
    expect(body.line_items[0]).toMatchObject({ product_id: 42, quantity: 1, subtotal: '2600.99', total: '2600.99' });
    expect(body.line_items[0].meta_data).toContainEqual({ key: '_bundle_id', value: item.bundleId });
    expect(result).toEqual({
      externalCheckoutId: '900',
      checkoutUrl: 'https://shop.example.com/checkout/order-pay/900/?pay_for_order=true&key=wc_order_abc',
    });
  });

  it('requires https', () => {
    expect(() => new WooCommerceConnector({ ...creds, siteUrl: 'http://shop.example.com' })).toThrow(/https/);
  });

  it('verifies and parses an order webhook', () => {
    const raw = Buffer.from(
      JSON.stringify({
        id: 900,
        number: '900',
        status: 'processing',
        currency: 'USD',
        customer_id: 5,
        line_items: [{ id: 1, quantity: 1, total: '2600.99', meta_data: [{ key: '_bundle_id', value: item.bundleId }] }],
      }),
    );
    const sig = createHmac('sha256', 'whsec').update(raw).digest('base64');
    const ok = receiveOrderWebhook('WOOCOMMERCE', raw, { 'x-wc-webhook-signature': sig }, 'whsec');
    expect(ok).toMatchObject({
      ok: true,
      order: { externalOrderId: '900', externalCheckoutId: '900', paid: true, lines: [{ unitPrice: '2600.99', bundleId: item.bundleId }] },
    });
    expect(receiveOrderWebhook('WOOCOMMERCE', raw, { 'x-wc-webhook-signature': sig }, 'other')).toEqual({ ok: false, reason: 'bad_signature' });
    expect(receiveOrderWebhook('WOOCOMMERCE', raw, {}, 'whsec').ok).toBe(false);
    // the ping Woo sends when a webhook is saved
    const ping = Buffer.from('{"webhook_id":3}');
    const pingSig = createHmac('sha256', 'whsec').update(ping).digest('base64');
    expect(receiveOrderWebhook('WOOCOMMERCE', ping, { 'x-wc-webhook-signature': pingSig }, 'whsec')).toEqual({ ok: true, order: null });
  });
});

describe('Wix', () => {
  it('creates a checkout with a custom line item, then fetches its URL', async () => {
    const fetchMock = reply({ checkout: { id: 'chk_1' } }, { checkoutUrl: 'https://site.example/checkout?id=chk_1' });
    const result = await new WixConnector({ apiKey: 'key', siteId: 'site' }, { fetch: fetchMock }).createCheckout(item);
    const create = sent(fetchMock, 0);
    expect(create.url).toBe('https://www.wixapis.com/ecom/v1/checkouts');
    expect(create.init.headers).toMatchObject({ authorization: 'key', 'wix-site-id': 'site' });
    expect(create.body.customLineItems[0]).toMatchObject({ quantity: 1, price: '2600.99', productName: { original: item.title } });
    expect(sent(fetchMock, 1).url).toBe('https://www.wixapis.com/ecom/v1/checkouts/chk_1/checkout-url');
    expect(result).toEqual({ externalCheckoutId: 'chk_1', checkoutUrl: 'https://site.example/checkout?id=chk_1' });
  });

  it('verifies the webhook JWT and matches by checkout id', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const jwt = (alg: string, payload: unknown) => {
      const signingInput = `${b64({ alg, typ: 'JWT' })}.${b64(payload)}`;
      return `${signingInput}.${createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url')}`;
    };
    const order = { id: 'ord_1', number: 1001, checkoutId: 'chk_1', currency: 'USD', paymentStatus: 'PAID', lineItems: [{ id: 'li_1', quantity: 1, price: { amount: '2600.99' } }] };
    const payload = { data: JSON.stringify({ eventType: 'wix.ecom.v1.order_approved', data: JSON.stringify({ actionEvent: { body: { order } } }) }) };

    const ok = receiveOrderWebhook('WIX', Buffer.from(jwt('RS256', payload)), {}, pem);
    expect(ok).toMatchObject({
      ok: true,
      order: { externalOrderId: 'ord_1', externalCheckoutId: 'chk_1', paid: true, lines: [{ externalLineItemId: 'li_1', unitPrice: '2600.99', bundleId: null }] },
    });

    const tampered = jwt('RS256', payload).replace(/\.[^.]+\./, `.${b64({ data: '{}' })}.`);
    expect(receiveOrderWebhook('WIX', Buffer.from(tampered), {}, pem).ok).toBe(false);
    expect(receiveOrderWebhook('WIX', Buffer.from(jwt('none', payload)), {}, pem).ok).toBe(false);
    expect(receiveOrderWebhook('WIX', Buffer.from('not-a-jwt'), {}, pem).ok).toBe(false);
  });
});
