/**
 * End-to-end tests against a real Postgres (and Redis when available).
 * Skipped unless TEST_DATABASE_URL points at a migrated, disposable database:
 *
 *   DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @jewelry/db migrate:deploy
 *   TEST_DATABASE_URL=… [TEST_REDIS_URL=…] pnpm test
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@jewelry/db';
import { encryptJson, encryptSecret, parseEncryptionKey } from '@jewelry/platforms';
import { verifyBundleToken } from '../src/common/bundleToken';
import { MemoryCache, RedisCache } from '../src/common/cache';
import { hashApiKey } from '../src/common/tenantAuth';
import { loadConfig } from '../src/config/env';
import { buildServer } from '../src/server';

const url = process.env.TEST_DATABASE_URL;
const SECRET = 'test-secret-test-secret-test-secret-1234';
const ORIGIN = 'https://shop.example.com';
const PK = 'pk_test_publishable';
const SK = 'sk_test_secret';
const ENC_KEY = 'ab'.repeat(32);
const WEBHOOK_SECRET = 'shpss_test_webhook_secret';

describe.skipIf(!url)('storefront API', () => {
  let db: PrismaClient;
  let app: FastifyInstance;
  let tenantId: string;
  const ids = { ovalVariant: '', roundVariant: '', unpricedVariant: '' };
  const stone: Record<string, string> = {};
  /** Requests the API made to the storefront platform. */
  const platformCalls: { url: string; headers: Record<string, string>; body: any }[] = [];
  let draftSeq = 0;

  const get = (path: string, headers: Record<string, string> = { 'x-api-key': PK, origin: ORIGIN }) =>
    app.inject({ method: 'GET', url: path, headers });
  const post = (body: unknown, headers: Record<string, string> = { 'x-api-key': PK, origin: ORIGIN }) =>
    app.inject({ method: 'POST', url: '/api/v1/bundle', headers, payload: body as object });

  function diamond(n: number, over: Partial<Prisma.DiamondCacheCreateInput>): Prisma.DiamondCacheCreateInput {
    return {
      source: 'NIVODA',
      sourceStockId: `s-${n}`,
      origin: 'NATURAL',
      shape: 'ROUND',
      carat: '1.00',
      color: 'G',
      clarity: 'VS1',
      cut: 'EXCELLENT',
      lab: 'GIA',
      certificateNumber: `10000${n}`,
      wholesalePrice: '1000.00',
      pricePerCarat: '1000.00',
      supplierName: 'Secret Supplier Ltd',
      ...over,
    };
  }

  beforeAll(async () => {
    db = new PrismaClient({ datasourceUrl: url });
    await db.$executeRawUnsafe(
      'TRUNCATE "tenants", "diamond_cache", "virtual_settings", "casting_vendors", "custom_merchant_stock" RESTART IDENTITY CASCADE',
    );

    const tenant = await db.tenant.create({
      data: {
        name: 'Example Jewelers',
        slug: 'example',
        platformType: 'SHOPIFY',
        subscriptionStatus: 'ACTIVE',
        platformStoreId: 'example.myshopify.com',
        platformCredentialsEnc: encryptJson(
          { shopDomain: 'example.myshopify.com', accessToken: 'shpat_test' },
          parseEncryptionKey(ENC_KEY),
        ),
        platformWebhookSecretEnc: encryptSecret(WEBHOOK_SECRET, parseEncryptionKey(ENC_KEY)),
        domains: { create: { hostname: 'shop.example.com', isPrimary: true } },
        apiKeys: {
          create: [
            { type: 'PUBLISHABLE', prefix: 'pk_test', keyHash: hashApiKey(PK) },
            { type: 'SECRET', prefix: 'sk_test', keyHash: hashApiKey(SK) },
            { type: 'SECRET', prefix: 'sk_dead', keyHash: hashApiKey('sk_revoked'), revokedAt: new Date() },
          ],
        },
        markupRules: {
          create: [
            // natural: 50 % under 1 ct, 40 % + $100 from 1 ct, rounded to $10
            { name: 'nat <1', origin: 'NATURAL', caratMax: '1', markupPercent: '50' },
            { name: 'nat 1+', origin: 'NATURAL', caratMin: '1', markupPercent: '40', fixedAddition: '100', rounding: 'NEAREST_10' },
            // lab-grown: doubled, but only up to $5,000 cost
            { name: 'lab', origin: 'LAB_GROWN', costMax: '5000', markupPercent: '100', rounding: 'ENDING_99' },
            { name: 'settings', target: 'SETTING', costMax: '2000', markupPercent: '150' },
            { name: 'own stones', target: 'MERCHANT_STONE', markupPercent: '25' },
          ],
        },
      },
    });
    tenantId = tenant.id;

    const other = await db.tenant.create({
      data: {
        name: 'Paused Jewelers',
        slug: 'paused',
        platformType: 'WIX',
        subscriptionStatus: 'CANCELED',
        apiKeys: { create: { type: 'SECRET', prefix: 'sk_paused', keyHash: hashApiKey('sk_paused') } },
      },
    });

    const stones: [string, Prisma.DiamondCacheCreateInput][] = [
      ['small', diamond(1, { carat: '0.90', wholesalePrice: '1000.00' })], // 1500.00
      ['one', diamond(2, { carat: '1.00', wholesalePrice: '1003.00' })], // 1504.2 → 1500
      ['big', diamond(3, { carat: '2.00', wholesalePrice: '9000.00', shape: 'OVAL', clarity: 'VVS2' })], // 12700
      ['lab', diamond(4, { origin: 'LAB_GROWN', carat: '1.50', wholesalePrice: '800.40', shape: 'OVAL', cut: 'IDEAL' })], // 1600.99
      ['labDear', diamond(5, { origin: 'LAB_GROWN', carat: '5.00', wholesalePrice: '6000.00' })], // no rule
      ['sold', diamond(6, { availability: 'SOLD' })],
      ['rapnet', diamond(7, { source: 'RAPNET' })], // tenant has no RapNet access
    ];
    for (const [name, data] of stones) stone[name] = (await db.diamondCache.create({ data })).id;

    const own = (sku: string, over: Partial<Prisma.CustomMerchantStockUncheckedCreateInput>) =>
      db.customMerchantStock.create({
        data: { tenantId, stockType: 'STONE', sku, origin: 'NATURAL', shape: 'OVAL', carat: '1.20', color: 'F', clarity: 'VS2', ...over },
      });
    stone.ownFixed = (await own('OWN-1', { retailPrice: '4321.00', costPrice: '1.00' })).id; // explicit price wins
    stone.ownMarkup = (await own('OWN-2', { costPrice: '2000.00', shape: 'ROUND', quantity: 2 })).id; // 2500.00
    await own('OWN-3', { shape: 'ROUND' }); // no price at all → hidden
    await own('OWN-4', { retailPrice: '999.00', quantity: 0 }); // out of stock → hidden
    await db.customMerchantStock.create({
      data: { tenantId: other.id, stockType: 'STONE', sku: 'THEIRS', origin: 'NATURAL', shape: 'OVAL', carat: '1.00', retailPrice: '50.00' },
    });

    const solitaire = await db.virtualSetting.create({
      data: {
        sku: 'SOL-1',
        name: 'Classic Solitaire',
        style: 'SOLITAIRE',
        compatibleShapes: ['ROUND', 'OVAL'],
        centerCaratMin: '0.50',
        centerCaratMax: '3.00',
        cadId: 'CAD-1',
        minRingSize: '4',
        maxRingSize: '9',
        variants: {
          create: [
            { metal: 'WHITE_GOLD_14K', castingCost: '400.00' }, // 1000
            { metal: 'PLATINUM_950', castingCost: '800.00' }, // 2000
            { metal: 'YELLOW_GOLD_18K', castingCost: '2500.00' }, // above costMax → not for sale
          ],
        },
        sideStones: { create: { shape: 'ROUND', quantity: 12, totalCarat: '0.240' } },
      },
      include: { variants: true },
    });
    ids.ovalVariant = solitaire.variants.find((v) => v.metal === 'WHITE_GOLD_14K')!.id;
    ids.unpricedVariant = solitaire.variants.find((v) => v.metal === 'YELLOW_GOLD_18K')!.id;

    const halo = await db.virtualSetting.create({
      data: {
        tenantId,
        sku: 'HALO-1',
        name: 'Round Halo',
        style: 'HALO',
        compatibleShapes: ['ROUND'],
        centerCaratMin: '0.95',
        centerCaratMax: '1.20',
        cadId: 'CAD-2',
        variants: { create: { metal: 'PLATINUM_950', castingCost: '600.00' } }, // 1500
      },
      include: { variants: true },
    });
    ids.roundVariant = halo.variants[0]!.id;

    await db.virtualSetting.create({
      data: {
        tenantId: other.id, // another tenant's private design
        sku: 'PRIVATE-1',
        name: 'Private Design',
        style: 'BEZEL',
        compatibleShapes: ['ROUND'],
        centerCaratMin: '0.50',
        centerCaratMax: '3.00',
        cadId: 'CAD-3',
        variants: { create: { metal: 'PLATINUM_950', castingCost: '500.00' } },
      },
    });

    const redisUrl = process.env.TEST_REDIS_URL;
    const cache = redisUrl ? new RedisCache(redisUrl) : new MemoryCache();
    app = await buildServer({
      db,
      cache,
      logger: false,
      config: loadConfig({
        NODE_ENV: 'test',
        BUNDLE_SIGNING_SECRET: SECRET,
        PLATFORM_FEEDS: 'NIVODA',
        SEARCH_CACHE_TTL_SECONDS: '30',
        CREDENTIALS_ENCRYPTION_KEY: ENC_KEY,
        RATE_LIMIT_PER_MINUTE: '100000',
        CHECKOUT_RATE_LIMIT_PER_MINUTE: '100000',
      }),
      // Stand-in for the Shopify Admin API.
      fetch: (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        platformCalls.push({ url, headers: init.headers as Record<string, string>, body });
        const n = ++draftSeq;
        const q: string = body.query;
        const data = q.includes('draftOrderCreate')
          ? {
              draftOrderCreate: {
                draftOrder: { id: `gid://shopify/DraftOrder/${n}`, invoiceUrl: `https://example.myshopify.com/invoices/${n}` },
                userErrors: [],
              },
            }
          : q.includes('productSet')
            ? {
                productSet: {
                  product: { id: `gid://shopify/Product/${n}`, variants: { nodes: [{ id: `gid://shopify/ProductVariant/${9000 + n}` }] } },
                  userErrors: [],
                },
              }
            : q.includes('publishablePublish')
              ? { publishablePublish: { userErrors: [] } }
              : { publications: { nodes: [{ id: 'gid://shopify/Publication/1', name: 'Online Store' }, { id: 'gid://shopify/Publication/2', name: 'POS' }] } };
        return new Response(JSON.stringify({ data }), { status: 200 });
      }) as typeof fetch,
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  describe('auth and CORS', () => {
    it('rejects missing, unknown and revoked keys', async () => {
      expect((await get('/api/v1/diamonds', {})).statusCode).toBe(401);
      expect((await get('/api/v1/diamonds', { 'x-api-key': 'nope' })).statusCode).toBe(401);
      expect((await get('/api/v1/diamonds', { 'x-api-key': 'sk_revoked' })).statusCode).toBe(401);
    });

    it('binds publishable keys to the tenant’s domains; secret keys work server-side', async () => {
      expect((await get('/api/v1/diamonds', { 'x-api-key': PK })).statusCode).toBe(403);
      expect((await get('/api/v1/diamonds', { 'x-api-key': PK, origin: 'https://evil.example' })).statusCode).toBe(403);
      expect((await get('/api/v1/diamonds', { 'x-api-key': SK })).statusCode).toBe(200);
      expect((await get('/api/v1/diamonds', { authorization: `Bearer ${SK}` })).statusCode).toBe(200);
    });

    it('blocks tenants without an active subscription', async () => {
      const res = await get('/api/v1/diamonds', { 'x-api-key': 'sk_paused' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('subscription_inactive');
    });

    it('answers preflight only for registered storefront origins', async () => {
      const preflight = (origin: string) =>
        app.inject({
          method: 'OPTIONS',
          url: '/api/v1/diamonds',
          headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-api-key' },
        });
      const ok = await preflight(ORIGIN);
      expect(ok.statusCode).toBe(204);
      expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(ok.headers['access-control-allow-headers']).toContain('x-api-key');
      expect((await preflight('https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
      expect((await get('/api/v1/diamonds')).headers['access-control-allow-origin']).toBe(ORIGIN);
    });
  });

  describe('GET /api/v1/diamonds', () => {
    const prices = (res: { json: () => { data: { id: string; price: { amount: string } }[] } }) =>
      res.json().data.map((d) => [Object.keys(stone).find((k) => stone[k] === d.id), d.price.amount]);

    it('returns only sellable stones, priced by the markup matrix, cheapest first', async () => {
      const res = await get('/api/v1/diamonds?inventory=feed');
      expect(res.statusCode).toBe(200);
      expect(res.json().total).toBe(4);
      // "one" and "small" tie at 1500.00 and fall back to id order
      expect(prices(res).slice(2)).toEqual([
        ['lab', '1600.99'],
        ['big', '12700.00'],
      ]);
      expect(new Map(prices(res) as [string, string][]).get('small')).toBe('1500.00');
      expect(new Map(prices(res) as [string, string][]).get('one')).toBe('1500.00');
    });

    it('never leaks wholesale data', async () => {
      const body = (await get('/api/v1/diamonds')).body;
      expect(body).not.toMatch(/wholesale|supplier|Secret Supplier|rapDiscount|"raw"/i);
    });

    it('filters on retail price, not wholesale', async () => {
      // wholesale 800.40 would fail a 1600 floor; retail 1600.99 passes
      const res = await get('/api/v1/diamonds?priceMin=1600&priceMax=2000');
      expect(prices(res)).toEqual([['lab', '1600.99']]);
      expect(res.json().total).toBe(1);
    });

    it('filters by shape, origin, carat, cut and clarity', async () => {
      expect(prices(await get('/api/v1/diamonds?shape=oval,pear&inventory=FEED'))).toEqual([
        ['lab', '1600.99'],
        ['big', '12700.00'],
      ]);
      expect((await get('/api/v1/diamonds?origin=lab_grown')).json().total).toBe(1);
      expect((await get('/api/v1/diamonds?caratMin=1&caratMax=1.5&inventory=FEED')).json().total).toBe(2);
      expect(prices(await get('/api/v1/diamonds?cut=IDEAL'))).toEqual([['lab', '1600.99']]);
      expect(prices(await get('/api/v1/diamonds?clarity=VVS1&clarity=VVS2'))).toEqual([['big', '12700.00']]);
    });

    it('sorts and paginates', async () => {
      const first = await get('/api/v1/diamonds?sort=price_desc&limit=1&inventory=FEED');
      expect(prices(first)).toEqual([['big', '12700.00']]);
      expect(first.json()).toMatchObject({ page: 1, limit: 1, total: 4, hasMore: true });
      const last = await get('/api/v1/diamonds?sort=carat_desc&limit=3&page=2&inventory=FEED');
      expect(prices(last)).toEqual([['small', '1500.00']]);
      expect(last.json().hasMore).toBe(false);
    });

    it('serves repeats from cache', async () => {
      const path = '/api/v1/diamonds?shape=OVAL&sort=carat_asc';
      const miss = await get(path);
      const hit = await get('/api/v1/diamonds?sort=carat_asc&shape=oval');
      expect(miss.headers['x-cache']).toBe('MISS');
      expect(hit.headers['x-cache']).toBe('HIT');
      expect(hit.json()).toEqual(miss.json());
    });

    it('merges the jeweler’s own stones into the same list', async () => {
      const res = await get('/api/v1/diamonds');
      expect(res.json().total).toBe(6);
      expect(prices(res)).toEqual([
        expect.anything(),
        expect.anything(),
        ['lab', '1600.99'],
        ['ownMarkup', '2500.00'], // cost 2000 + 25 %
        ['ownFixed', '4321.00'], // explicit retail price
        ['big', '12700.00'],
      ]);
      const own = res.json().data.filter((d: { inventory: string }) => d.inventory === 'MERCHANT');
      expect(own).toHaveLength(2);
      expect(prices(await get('/api/v1/diamonds?inventory=merchant&shape=OVAL'))).toEqual([['ownFixed', '4321.00']]);
      expect(prices(await get('/api/v1/diamonds?priceMin=2400&priceMax=5000'))).toEqual([
        ['ownMarkup', '2500.00'],
        ['ownFixed', '4321.00'],
      ]);
    });

    it('rejects bad input with 400', async () => {
      for (const q of ['shape=BANANA', 'caratMin=abc', 'limit=1000', 'caratMin=2&caratMax=1', 'sort=random']) {
        const res = await get(`/api/v1/diamonds?${q}`);
        expect(res.statusCode, q).toBe(400);
      }
    });
  });

  describe('GET /api/v1/settings', () => {
    it('lists own and platform settings with priced variants only', async () => {
      const res = await get('/api/v1/settings');
      expect(res.statusCode).toBe(200);
      const data = res.json().data as { name: string; variants: { metal: string; price: { amount: string } }[]; priceFrom: { amount: string } }[];
      expect(data.map((s) => s.name)).toEqual(['Classic Solitaire', 'Round Halo']);
      expect(data[0]!.variants.map((v) => [v.metal, v.price.amount])).toEqual([
        ['WHITE_GOLD_14K', '1000.00'],
        ['PLATINUM_950', '2000.00'],
      ]);
      expect(data[0]!.priceFrom.amount).toBe('1000.00');
      expect(res.body).not.toMatch(/castingCost|cadId|Private Design/);
    });

    it('filters by metal, compatible shape, style and carat', async () => {
      const names = async (q: string) =>
        ((await get(`/api/v1/settings?${q}`)).json().data as { name: string }[]).map((s) => s.name);
      expect(await names('metal=white_gold_14k')).toEqual(['Classic Solitaire']);
      expect(await names('metal=PLATINUM_950')).toEqual(['Classic Solitaire', 'Round Halo']);
      expect(await names('shape=OVAL')).toEqual(['Classic Solitaire']);
      expect(await names('shape=OVAL,ROUND&style=HALO')).toEqual(['Round Halo']);
      expect(await names('carat=2')).toEqual(['Classic Solitaire']);
      expect(await names('metal=YELLOW_GOLD_18K')).toEqual([]); // only an unpriced variant
      expect(await names('shape=HEART')).toEqual([]);

      const platinum = (await get('/api/v1/settings?metal=PLATINUM_950')).json().data[0];
      expect(platinum.variants).toHaveLength(1);
    });
  });

  describe('POST /api/v1/bundle', () => {
    it('builds one signed line item from a setting and a diamond', async () => {
      const res = await post({
        settingVariantId: ids.ovalVariant,
        diamondId: stone.lab,
        ringSize: 6.5,
        engraving: 'Forever ♥',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.lineItem).toMatchObject({
        title: 'Classic Solitaire in 14K White Gold with 1.50ct Oval Diamond',
        sku: 'SOL-1-WHITE_GOLD_14K',
        quantity: 1,
        price: { amount: '2600.99', currency: 'USD' },
      });
      expect(body.lineItem.properties).toMatchObject({
        Metal: '14K White Gold',
        'Ring size': '6.5',
        Diamond: '1.50ct Oval Lab-Grown G VS1 Ideal',
        Certificate: 'GIA 100004',
        Engraving: 'Forever ♥',
        _bundle_id: body.bundleId,
      });
      expect(body.components.map((c: { price: { amount: string } }) => c.price.amount)).toEqual(['1000.00', '1600.99']);

      const claims = verifyBundleToken(body.token, SECRET);
      expect(claims).toMatchObject({
        tenantId,
        settingVariantId: ids.ovalVariant,
        stoneSource: 'FEED',
        stoneId: stone.lab,
        total: '2600.99',
        ringSize: '6.5',
      });
      expect(verifyBundleToken(body.token, 'x'.repeat(40))).toBeNull();
      // flip a character inside the signature (the last one only carries padding bits)
      const [payloadPart, sig] = body.token.split('.') as [string, string];
      const forged = `${payloadPart}.${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
      expect(verifyBundleToken(forged, SECRET)).toBeNull();
      expect(verifyBundleToken(body.token, SECRET, Date.now() + 3 * 3600 * 1000)).toBeNull();
    });

    it.each([
      ['unknown diamond', () => ({ diamondId: randomUUID() }), 404, 'diamond_not_found'],
      ['diamond from a feed the tenant cannot access', () => ({ diamondId: stone.rapnet }), 404, 'diamond_not_found'],
      ['diamond no rule prices', () => ({ diamondId: stone.labDear }), 404, 'diamond_not_found'],
      ['sold diamond', () => ({ diamondId: stone.sold }), 409, 'diamond_unavailable'],
      ['variant no rule prices', () => ({ settingVariantId: ids.unpricedVariant }), 404, 'setting_not_found'],
      ['wrong shape', () => ({ settingVariantId: ids.roundVariant, diamondId: stone.lab }), 422, 'incompatible_shape'],
      ['carat out of range', () => ({ settingVariantId: ids.roundVariant, diamondId: stone.small }), 422, 'incompatible_carat'],
      ['ring size not offered', () => ({ ringSize: 12 }), 422, 'ring_size_unavailable'],
    ])('rejects: %s', async (_name, override, status, code) => {
      const res = await post({ settingVariantId: ids.ovalVariant, diamondId: stone.one, ringSize: 6, ...override() });
      expect(res.statusCode).toBe(status);
      expect(res.json().error.code).toBe(code);
    });

    it('validates the body', async () => {
      expect((await post({ settingVariantId: 'x', diamondId: stone.one, ringSize: 6 })).statusCode).toBe(400);
      expect((await post({ settingVariantId: ids.ovalVariant, diamondId: stone.one })).statusCode).toBe(400);
      const res = await post({ settingVariantId: ids.ovalVariant, diamondId: stone.one, ringSize: 6, engraving: '<script>' + 'x'.repeat(40) });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('checkout and order webhook', () => {
    const quote = async (body: object) => (await post({ ringSize: 6, ...body })).json();
    const checkout = (token: string) =>
      app.inject({ method: 'POST', url: '/api/v1/checkout', headers: { 'x-api-key': PK, origin: ORIGIN }, payload: { token } });
    const webhook = (payload: object, opts: { secret?: string; topic?: string } = {}) => {
      const raw = JSON.stringify(payload);
      const hmac = createHmac('sha256', opts.secret ?? WEBHOOK_SECRET).update(raw).digest('base64');
      return app.inject({
        method: 'POST',
        url: `/webhooks/shopify/${tenantId}`,
        headers: { 'content-type': 'application/json', 'x-shopify-hmac-sha256': hmac, 'x-shopify-topic': opts.topic ?? 'orders/paid' },
        payload: raw,
      });
    };
    const order = (id: number, bundleId: string, price: string) => ({
      id,
      name: `#${id}`,
      currency: 'USD',
      customer: { id: 77 },
      line_items: [
        { id: id * 10, price, quantity: 1, properties: [{ name: 'Metal', value: 'x' }, { name: '_bundle_id', value: bundleId }] },
        { id: id * 10 + 1, price: '20.00', quantity: 1, properties: [] }, // an unrelated product
      ],
    });

    it('creates a draft order with the server price and is idempotent', async () => {
      const q = await quote({ settingVariantId: ids.ovalVariant, diamondId: stone.lab, engraving: 'A+B' });
      const res = await checkout(q.token);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ bundleId: q.bundleId, checkoutUrl: expect.stringContaining('/invoices/') });

      const call = platformCalls.at(-1)!;
      expect(call.url).toMatch(/^https:\/\/example\.myshopify\.com\/admin\/api\/[\d-]+\/graphql\.json$/);
      expect(call.headers['x-shopify-access-token']).toBe('shpat_test');
      const line = call.body.variables.input.lineItems[0];
      expect(line).toMatchObject({ originalUnitPrice: '2600.99', quantity: 1, sku: 'SOL-1-WHITE_GOLD_14K' });
      expect(line.customAttributes).toContainEqual({ key: '_bundle_id', value: q.bundleId });
      expect(line.customAttributes).toContainEqual({ key: 'Engraving', value: 'A+B' });

      const calls = platformCalls.length;
      expect((await checkout(q.token)).json().checkoutUrl).toBe(res.json().checkoutUrl);
      expect(platformCalls.length).toBe(calls); // no second draft order

      const session = await db.checkoutSession.findUniqueOrThrow({ where: { id: q.bundleId } });
      expect(session).toMatchObject({ status: 'OPEN', stoneSource: 'FEED', stoneId: stone.lab });
      expect(session.total.toFixed(2)).toBe('2600.99');
    });

    it('rejects forged or foreign tokens', async () => {
      const q = await quote({ settingVariantId: ids.ovalVariant, diamondId: stone.one });
      expect((await checkout(q.token.slice(0, -2) + 'xx')).statusCode).toBe(400);
      expect((await checkout('garbage')).statusCode).toBe(400);
    });

    it('turns a paid order into one confirmed job bag and holds the diamond', async () => {
      const session = await db.checkoutSession.findFirstOrThrow({ where: { stoneId: stone.lab } });
      const res = await webhook(order(5001, session.id, '2600.99'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ handled: true, duplicates: 0 });
      expect(res.json().castingOrders[0]).toMatch(/^JB-\d{6}-[0-9A-Z]{6}$/);

      const job = await db.castingOrder.findUniqueOrThrow({
        where: { checkoutSessionId: session.id },
        include: { routeSteps: { orderBy: { sequence: 'asc' } } },
      });
      expect(job).toMatchObject({
        status: 'CONFIRMED',
        externalOrderId: '5001',
        externalLineItemId: '50010',
        customerReference: '77',
        metal: 'WHITE_GOLD_14K',
        cadId: 'CAD-1',
        engraving: 'A+B',
        centerDiamondId: stone.lab,
        currentStage: 'CAD_PREP',
      });
      expect([job.castingCost.toFixed(2), job.stoneCost.toFixed(2), job.retailTotal.toFixed(2)]).toEqual(['400.00', '800.40', '2600.99']);
      expect(job.routeSteps.map((s) => s.stage)).toEqual([
        'CAD_PREP', 'WAX_PRINT', 'CASTING', 'CLEANUP', 'STONE_PROCUREMENT', 'STONE_SETTING', 'POLISHING', 'ENGRAVING', 'QUALITY_CONTROL', 'PACKAGING',
      ]);
      expect((job.centerStoneSnapshot as { certificateNumber: string }).certificateNumber).toBe('100004');
      expect((await db.diamondCache.findUniqueOrThrow({ where: { id: stone.lab } })).availability).toBe('ON_HOLD');
      expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('ORDERED');

      // redelivery, and the same bundle arriving under a second order id
      expect((await webhook(order(5001, session.id, '2600.99'))).json()).toMatchObject({ castingOrders: [], duplicates: 1 });
      expect((await webhook(order(5002, session.id, '2600.99'))).json()).toMatchObject({ castingOrders: [], duplicates: 1 });
      expect(await db.castingOrder.count({ where: { checkoutSessionId: session.id } })).toBe(1);
      // the held stone has left search and cannot be bundled again
      expect((await get('/api/v1/diamonds?inventory=feed')).json().total).toBe(3);
      expect((await post({ settingVariantId: ids.ovalVariant, diamondId: stone.lab, ringSize: 6 })).statusCode).toBe(409);
    });

    it('puts an underpaid order on hold and decrements merchant stock', async () => {
      const q = await quote({ settingVariantId: ids.roundVariant, diamondId: stone.ownMarkup, inventory: 'MERCHANT' });
      expect(q.lineItem.price.amount).toBe('4000.00'); // 1500 setting + 2500 stone
      expect((await checkout(q.token)).statusCode).toBe(200);

      const res = await webhook(order(5003, q.bundleId, '10.00'));
      expect(res.statusCode).toBe(200);
      const job = await db.castingOrder.findUniqueOrThrow({ where: { checkoutSessionId: q.bundleId }, include: { routeSteps: true } });
      expect(job.status).toBe('ON_HOLD');
      expect(job.notes).toMatch(/Paid 10\.00 but the bundle was quoted at 4000\.00/);
      expect(job.centerMerchantStockId).toBe(stone.ownMarkup);
      expect(job.routeSteps.map((s) => s.stage)).not.toContain('STONE_PROCUREMENT');
      expect((await db.customMerchantStock.findUniqueOrThrow({ where: { id: stone.ownMarkup } })).quantity).toBe(1);
    });

    it('prepares a native-cart item and matches its order by variant id', async () => {
      const q = await quote({ settingVariantId: ids.ovalVariant, diamondId: stone.big });
      const cartItem = (token: string) =>
        app.inject({ method: 'POST', url: '/api/v1/cart-item', headers: { 'x-api-key': PK, origin: ORIGIN }, payload: { token } });
      const before = platformCalls.length;
      const res = await cartItem(q.token);
      expect(res.statusCode).toBe(200);
      const item = res.json();
      expect(item).toMatchObject({ bundleId: q.bundleId, platform: 'SHOPIFY', quantity: 1 });
      expect(item.purchasableId).toMatch(/^9\d{3}$/);
      expect(item.properties).toMatchObject({ Metal: '14K White Gold', _bundle_id: q.bundleId });

      const [pubs, set, publish] = platformCalls.slice(before).map((c) => c.body);
      expect(pubs.query).toContain('publications');
      expect(set.variables.input).toMatchObject({ status: 'ACTIVE', variants: [{ price: '13700.00' }] });
      expect(publish.variables).toMatchObject({ input: [{ publicationId: 'gid://shopify/Publication/1' }] });

      const stored = await db.checkoutSession.findUniqueOrThrow({ where: { id: q.bundleId } });
      expect(stored.externalProductId).toMatch(/^gid:\/\/shopify\/Product\/\d+$/); // kept so the worker can delete it

      const calls = platformCalls.length;
      expect((await cartItem(q.token)).json().purchasableId).toBe(item.purchasableId); // retry makes no new product
      expect(platformCalls.length).toBe(calls);

      // the paid order carries no bundle property here; the variant id identifies it
      const paid = await webhook({
        id: 5100,
        currency: 'USD',
        line_items: [{ id: 51000, variant_id: Number(item.purchasableId), price: '13700.00', quantity: 1, properties: [] }],
      });
      expect(paid.json().castingOrders).toHaveLength(1);
      const job = await db.castingOrder.findUniqueOrThrow({ where: { checkoutSessionId: q.bundleId } });
      expect(job).toMatchObject({ status: 'CONFIRMED', centerDiamondId: stone.big });
    });

    it('rejects bad signatures and ignores unpaid or unrelated orders', async () => {
      expect((await webhook(order(6001, randomUUID(), '1.00'), { secret: 'wrong' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: `/webhooks/shopify/${randomUUID()}`, payload: '{}' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: `/webhooks/wix/${tenantId}`, payload: 'x' })).statusCode).toBe(401); // wrong platform for this tenant
      const unpaid = await webhook(order(6002, randomUUID(), '1.00'), { topic: 'orders/create' });
      expect(unpaid.json()).toEqual({ received: true, handled: false });
      const unrelated = await webhook(order(6003, randomUUID(), '1.00'));
      expect(unrelated.json()).toMatchObject({ handled: true, castingOrders: [] });
      expect(await db.castingOrder.count()).toBe(3);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 past the per-minute limit', async () => {
      const limited = await buildServer({
        db,
        cache: new MemoryCache(),
        logger: false,
        config: loadConfig({ NODE_ENV: 'test', BUNDLE_SIGNING_SECRET: SECRET, RATE_LIMIT_PER_MINUTE: '3' }),
      });
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        codes.push((await limited.inject({ url: '/api/v1/settings', headers: { 'x-api-key': SK } })).statusCode);
      }
      // unauthenticated guesses are throttled as well
      const guesses: number[] = [];
      for (let i = 0; i < 5; i++) {
        guesses.push((await limited.inject({ url: '/api/v1/settings', headers: { 'x-api-key': 'guess' } })).statusCode);
      }
      await limited.close();
      expect(codes).toEqual([200, 200, 200, 429, 429]);
      expect(guesses).toEqual([401, 401, 401, 429, 429]);
    });
  });
});
