/**
 * End-to-end tests against a real Postgres (and Redis when available).
 * Skipped unless TEST_DATABASE_URL points at a migrated, disposable database:
 *
 *   DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @jewelry/db migrate:deploy
 *   TEST_DATABASE_URL=… [TEST_REDIS_URL=…] pnpm test
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@jewelry/db';
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

describe.skipIf(!url)('storefront API', () => {
  let db: PrismaClient;
  let app: FastifyInstance;
  let tenantId: string;
  const ids = { ovalVariant: '', roundVariant: '', unpricedVariant: '' };
  const stone: Record<string, string> = {};

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
      'TRUNCATE "tenants", "diamond_cache", "virtual_settings", "casting_vendors" RESTART IDENTITY CASCADE',
    );

    const tenant = await db.tenant.create({
      data: {
        name: 'Example Jewelers',
        slug: 'example',
        platformType: 'SHOPIFY',
        subscriptionStatus: 'ACTIVE',
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
      }),
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
      const res = await get('/api/v1/diamonds');
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
      expect(prices(await get('/api/v1/diamonds?shape=oval,pear'))).toEqual([
        ['lab', '1600.99'],
        ['big', '12700.00'],
      ]);
      expect((await get('/api/v1/diamonds?origin=lab_grown')).json().total).toBe(1);
      expect((await get('/api/v1/diamonds?caratMin=1&caratMax=1.5')).json().total).toBe(2);
      expect(prices(await get('/api/v1/diamonds?cut=IDEAL'))).toEqual([['lab', '1600.99']]);
      expect(prices(await get('/api/v1/diamonds?clarity=VVS1&clarity=VVS2'))).toEqual([['big', '12700.00']]);
    });

    it('sorts and paginates', async () => {
      const first = await get('/api/v1/diamonds?sort=price_desc&limit=1');
      expect(prices(first)).toEqual([['big', '12700.00']]);
      expect(first.json()).toMatchObject({ page: 1, limit: 1, total: 4, hasMore: true });
      const last = await get('/api/v1/diamonds?sort=carat_desc&limit=3&page=2');
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
        _bundle_token: body.token,
      });
      expect(body.components.map((c: { price: { amount: string } }) => c.price.amount)).toEqual(['1000.00', '1600.99']);

      const claims = verifyBundleToken(body.token, SECRET);
      expect(claims).toMatchObject({
        tenantId,
        settingVariantId: ids.ovalVariant,
        diamondId: stone.lab,
        total: '2600.99',
        ringSize: '6.5',
      });
      expect(verifyBundleToken(body.token, 'x'.repeat(40))).toBeNull();
      expect(verifyBundleToken(body.token.replace(/.$/, 'A'), SECRET)).toBeNull();
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
});
