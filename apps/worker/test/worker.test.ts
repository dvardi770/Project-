/**
 * Worker jobs against a real Postgres. Skipped unless TEST_DATABASE_URL is set
 * (see apps/api/test/api.test.ts for how to prepare the database).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@jewelry/db';
import { encryptJson, parseEncryptionKey } from '@jewelry/platforms';
import { MemoryCache, inventoryEpoch } from '@jewelry/shared/cache';
import { runCartCleanup } from '../src/jobs/cartCleanup';
import { runFeedSync } from '../src/jobs/feedSync';
import { runSupplierHolds } from '../src/jobs/supplierHolds';

const url = process.env.TEST_DATABASE_URL;
const KEY = parseEncryptionKey('cd'.repeat(32));
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe.skipIf(!url)('worker jobs', () => {
  let db: PrismaClient;
  let tenantId: string;
  let variantId: string;

  beforeAll(async () => {
    db = new PrismaClient({ datasourceUrl: url });
    await db.$executeRawUnsafe(
      'TRUNCATE "tenants", "diamond_cache", "virtual_settings", "casting_vendors", "custom_merchant_stock" RESTART IDENTITY CASCADE',
    );
    const tenant = await db.tenant.create({
      data: {
        name: 'Worker Test',
        slug: 'worker-test',
        platformType: 'WOOCOMMERCE',
        subscriptionStatus: 'ACTIVE',
        platformCredentialsEnc: encryptJson(
          { siteUrl: 'https://shop.example.com', consumerKey: 'ck', consumerSecret: 'cs', placeholderProductId: 1 },
          KEY,
        ),
      },
    });
    tenantId = tenant.id;
    const setting = await db.virtualSetting.create({
      data: {
        sku: 'W-1',
        name: 'Worker Setting',
        style: 'SOLITAIRE',
        compatibleShapes: ['ROUND'],
        centerCaratMin: '0.5',
        centerCaratMax: '3',
        cadId: 'CAD-W',
        variants: { create: { metal: 'PLATINUM_950', castingCost: '500' } },
      },
      include: { variants: true },
    });
    variantId = setting.variants[0]!.id;
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const session = (over: { status?: 'OPEN' | 'ORDERED' | 'EXPIRED'; expiresAt?: Date; externalProductId?: string | null }) =>
    db.checkoutSession.create({
      data: {
        id: randomUUID(),
        tenantId,
        platform: 'WOOCOMMERCE',
        settingVariantId: variantId,
        stoneSource: 'FEED',
        stoneId: randomUUID(),
        ringSize: '6',
        settingPrice: '1000',
        stonePrice: '2000',
        total: '3000',
        currency: 'USD',
        expiresAt: new Date(Date.now() + 86_400_000),
        ...over,
      },
    });

  describe('cart cleanup', () => {
    it('expires stale sessions and deletes products that are no longer needed', async () => {
      const longAgo = new Date(Date.now() - 86_400_000);
      const live = await session({ externalProductId: '101' }); // still shoppable
      const stale = await session({ externalProductId: '102', expiresAt: longAgo });
      const ordered = await session({ externalProductId: '103', status: 'ORDERED' });
      const justOrdered = await session({ externalProductId: '104', status: 'ORDERED' });
      const failing = await session({ externalProductId: '105', expiresAt: longAgo });
      const gone = await session({ externalProductId: '106', expiresAt: longAgo }); // already deleted on the store
      const hosted = await session({ expiresAt: longAgo }); // hosted checkout: no product
      // "ordered" was paid two hours ago; "justOrdered" a moment ago
      await db.$executeRaw`UPDATE "checkout_sessions" SET "updatedAt" = now() - interval '2 hours' WHERE "id" = ${ordered.id}::uuid`;

      const deleted: string[] = [];
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const id = String(input).match(/products\/(\d+)\?force=true$/)?.[1];
        expect(init?.method).toBe('DELETE');
        if (id === '105') return json({ message: 'boom' }, 500);
        if (id === '106') return json({ code: 'woocommerce_rest_product_invalid_id' }, 404);
        deleted.push(id!);
        return json({ id: Number(id) });
      });

      const result = await runCartCleanup({ db, credentialsKey: KEY, log: quiet, http: { fetch: fetchMock as typeof fetch } });

      expect(result).toEqual({ expired: 4, productsDeleted: 3, productsFailed: 1 });
      expect(deleted.sort()).toEqual(['102', '103']);
      const state = async (id: string) => {
        const s = await db.checkoutSession.findUniqueOrThrow({ where: { id } });
        return [s.status, s.productDeletedAt !== null];
      };
      expect(await state(live.id)).toEqual(['OPEN', false]);
      expect(await state(stale.id)).toEqual(['EXPIRED', true]);
      expect(await state(ordered.id)).toEqual(['ORDERED', true]);
      expect(await state(justOrdered.id)).toEqual(['ORDERED', false]);
      expect(await state(failing.id)).toEqual(['EXPIRED', false]); // retried next run
      expect(await state(gone.id)).toEqual(['EXPIRED', true]);
      expect(await state(hosted.id)).toEqual(['EXPIRED', false]);

      // a second run only retries the failure
      fetchMock.mockClear();
      const again = await runCartCleanup({ db, credentialsKey: KEY, log: quiet, http: { fetch: fetchMock as typeof fetch } });
      expect(again).toEqual({ expired: 0, productsDeleted: 0, productsFailed: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still expires sessions when products cannot be removed', async () => {
      const stale = await session({ externalProductId: '201', expiresAt: new Date(Date.now() - 1000) });
      const result = await runCartCleanup({ db, credentialsKey: null, log: quiet });
      expect(result).toEqual({ expired: 1, productsDeleted: 0, productsFailed: 0 });
      expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('EXPIRED');
    });
  });

  describe('feed sync', () => {
    const nivodaItem = (n: number, price: number) => ({
      id: `offer-${n}`,
      price,
      diamond: {
        id: `nv-${n}`,
        availability: 'AVAILABLE',
        image: `https://cdn.example.com/${n}.jpg`,
        certificate: { lab: 'GIA', shape: 'ROUND', certNumber: `GIA ${5000 + n}`, carats: 1 + n / 10, color: 'F', clarity: 'VS1', cut: 'EX' },
      },
    });
    const nivoda = (natural: unknown[], lab: unknown[]) =>
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const query = JSON.parse(String(init?.body)).query as string;
        if (query.includes('authenticate')) return json({ data: { authenticate: { username_and_password: { token: 't' } } } });
        const items = query.includes('labgrown: true') ? lab : natural;
        return json({ data: { diamonds_by_query: { total_count: items.length, items } } });
      });
    const run = (cache: MemoryCache, fetchMock: ReturnType<typeof nivoda>) =>
      runFeedSync({ db, cache, log: quiet, nivoda: { username: 'u', password: 'p', fetch: fetchMock as typeof fetch, sleep: async () => {} } });

    it('loads the feed, keeps ordered stones on hold, withdraws missing ones and drops cached searches', async () => {
      const cache = new MemoryCache();
      const first = await run(cache, nivoda([nivodaItem(1, 500000), nivodaItem(2, 600000)], [nivodaItem(3, 90000)]));
      expect(first).toMatchObject({ upserted: 3, rejected: 0, markedUnavailable: 0 });
      const epoch = await inventoryEpoch(cache);
      expect(epoch).not.toBe('0');

      const stone = await db.diamondCache.findUniqueOrThrow({ where: { source_sourceStockId: { source: 'NIVODA', sourceStockId: 'nv-1' } } });
      expect(stone).toMatchObject({ origin: 'NATURAL', certificateNumber: '5001', availability: 'AVAILABLE' });
      expect(stone.wholesalePrice.toFixed(2)).toBe('5000.00');

      // a customer orders nv-1
      await db.diamondCache.update({ where: { id: stone.id }, data: { availability: 'ON_HOLD' } });
      await db.castingOrder.create({
        data: {
          tenantId,
          jobBagNumber: 'JB-TEST-000001',
          status: 'CONFIRMED',
          externalOrderId: 'o-1',
          settingVariantId: variantId,
          metal: 'PLATINUM_950',
          cadId: 'CAD-W',
          ringSize: '6',
          centerDiamondId: stone.id,
          centerStoneSnapshot: {},
          castingCost: '500',
          stoneCost: '5000',
          retailTotal: '9000',
        },
      });

      // next sync: Nivoda still lists nv-1 as available, and nv-2 has gone
      const second = await run(cache, nivoda([nivodaItem(1, 510000)], [nivodaItem(3, 90000)]));
      expect(second).toMatchObject({ upserted: 2, markedUnavailable: 1 });
      const availability = async (id: string) =>
        (await db.diamondCache.findUniqueOrThrow({ where: { source_sourceStockId: { source: 'NIVODA', sourceStockId: id } } })).availability;
      expect(await availability('nv-1')).toBe('ON_HOLD');
      expect(await availability('nv-2')).toBe('UNAVAILABLE');
      expect(await availability('nv-3')).toBe('AVAILABLE');
      expect(await inventoryEpoch(cache)).not.toBe(epoch);
    });

    it('reserves confirmed Nivoda stones and puts refused ones on hold for review', async () => {
      const order = async (n: number, stockId: string, status: 'CONFIRMED' | 'ON_HOLD' = 'CONFIRMED') => {
        const d = await db.diamondCache.create({
          data: { source: 'NIVODA', sourceStockId: stockId, origin: 'NATURAL', shape: 'ROUND', carat: '1', wholesalePrice: '1000', pricePerCarat: '1000', availability: 'ON_HOLD' },
        });
        return db.castingOrder.create({
          data: {
            tenantId, jobBagNumber: `JB-HOLD-${n}`, status, externalOrderId: `h-${n}`, settingVariantId: variantId, metal: 'PLATINUM_950',
            cadId: 'CAD-W', ringSize: '6', centerDiamondId: d.id, centerStoneSnapshot: {}, castingCost: '500', stoneCost: '1000', retailTotal: '3000',
          },
        });
      };
      const ok = await order(1, 'aaaaaaaa-1111-4111-8111-111111111111');
      const refused = await order(2, 'bbbbbbbb-2222-4222-8222-222222222222');
      const flaky = await order(3, 'cccccccc-3333-4333-8333-333333333333');
      const review = await order(4, 'dddddddd-4444-4444-8444-444444444444', 'ON_HOLD');
      await db.castingOrder.updateMany({ where: { jobBagNumber: 'JB-TEST-000001' }, data: { supplierHoldAttemptedAt: new Date() } });

      const asked: string[] = [];
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const query = JSON.parse(String(init?.body)).query as string;
        if (query.includes('authenticate')) return json({ data: { authenticate: { username_and_password: { token: 't' } } } });
        const id = query.match(/ProductId: "([^"]+)"/)![1]!;
        asked.push(id);
        if (id.startsWith('bbbb')) return json({ data: { create_hold: { id: 'hold-b', denied: true, until: null } } });
        if (id.startsWith('cccc')) return json({ errors: [{ message: 'Something went wrong' }] });
        return json({ data: { create_hold: { id: 'hold-a', denied: false, until: '2026-12-01T00:00:00.000Z' } } });
      });
      const deps = { db, log: quiet, nivoda: { username: 'u', password: 'p', fetch: fetchMock as typeof fetch, sleep: async () => {} } };

      expect(await runSupplierHolds({ ...deps, enabled: false })).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();

      expect(await runSupplierHolds({ ...deps, enabled: true })).toEqual({ held: 1, denied: 1, failed: 1 });
      expect(asked.sort()).toEqual(['aaaaaaaa-1111-4111-8111-111111111111', 'bbbbbbbb-2222-4222-8222-222222222222', 'cccccccc-3333-4333-8333-333333333333']);
      const get = (id: string) => db.castingOrder.findUniqueOrThrow({ where: { id } });
      expect(await get(ok.id)).toMatchObject({ status: 'CONFIRMED', supplierHoldId: 'hold-a', supplierHoldUntil: new Date('2026-12-01T00:00:00.000Z') });
      const r = await get(refused.id);
      expect(r).toMatchObject({ status: 'ON_HOLD', supplierHoldId: null });
      expect(r.notes).toMatch(/Nivoda declined/);
      expect((await get(flaky.id)).supplierHoldAttemptedAt).toBeNull(); // retried next run
      expect((await get(review.id)).supplierHoldAttemptedAt).toBeNull(); // waiting for a person, not touched

      asked.length = 0;
      expect(await runSupplierHolds({ ...deps, enabled: true })).toEqual({ held: 0, denied: 0, failed: 1 });
      expect(asked).toEqual(['cccccccc-3333-4333-8333-333333333333']);
    });

    it('does nothing without Nivoda credentials', async () => {
      expect(await runFeedSync({ db, cache: new MemoryCache(), log: quiet, nivoda: null })).toBeNull();
    });
  });
});
