import { describe, expect, it, vi } from 'vitest';
import { NivodaClient, ingestNivoda, normalizeNivodaItem, type NivodaItem } from './nivodaIngestor';

function item(n: number, overrides: Partial<NivodaItem> = {}): NivodaItem {
  return {
    id: `offer-${n}`,
    price: 525200,
    discount: -32.5,
    diamond: {
      id: `stone-${n}`,
      video: 'http://v360.example.com/view/1',
      image: ' https://cdn.example.com/1.jpg ',
      availability: 'AVAILABLE',
      certificate: {
        lab: 'GIA',
        shape: 'ROUND',
        certNumber: 'GIA-2141438167',
        carats: 1.01,
        color: 'G',
        clarity: 'VS1',
        cut: 'EX',
        polish: 'EX',
        symmetry: 'VG',
        floInt: 'NON',
        length: 6.45,
        width: 6.48,
        depth: 3.99,
        depthPercentage: 61.8,
        table: 57,
      },
    },
    ...overrides,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const authOk = () => json({ data: { authenticate: { username_and_password: { token: 'tok-1' } } } });
const page = (items: NivodaItem[], total: number) =>
  json({ data: { as: { diamonds_by_query: { total_count: total, items } } } });

function fakeDb() {
  const upsert = vi.fn((args: unknown) => args);
  const updateMany = vi.fn().mockResolvedValue({ count: 3 });
  const $transaction = vi.fn(async (ops: unknown[]) => ops);
  return { db: { diamondCache: { upsert, updateMany }, $transaction } as never, upsert, updateMany };
}

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const base = { username: 'u"ser', password: 'p\\w', sleep: async () => {}, logger: quiet };

describe('normalizeNivodaItem', () => {
  it('maps certificate, media and price (cents → dollars)', () => {
    const d = normalizeNivodaItem(item(1), 'NATURAL');
    expect(d).toMatchObject({
      source: 'NIVODA',
      sourceStockId: 'stone-1',
      origin: 'NATURAL',
      lab: 'GIA',
      certificateNumber: '2141438167',
      shape: 'ROUND',
      color: 'G',
      clarity: 'VS1',
      cut: 'EXCELLENT',
      symmetry: 'VERY_GOOD',
      fluorescence: 'NONE',
      videoUrl: 'https://v360.example.com/view/1',
      imageUrl: 'https://cdn.example.com/1.jpg',
      availability: 'AVAILABLE',
    });
    expect(d.wholesalePrice.toFixed(2)).toBe('5252.00');
    expect(d.pricePerCarat.toFixed(2)).toBe('5200.00');
    expect(d.rapDiscountPct?.toString()).toBe('-32.5');
  });

  it('honours priceUnit and rejects unusable items', () => {
    expect(normalizeNivodaItem(item(1, { price: 5252 }), 'LAB_GROWN', 'dollars').wholesalePrice.toFixed(2)).toBe('5252.00');
    expect(() => normalizeNivodaItem(item(1, { price: null }), 'NATURAL')).toThrow(/price/);
    expect(() => normalizeNivodaItem({ id: 'x', price: 1, diamond: { id: 's' } }, 'NATURAL')).toThrow(/certificate/);
  });
});

describe('NivodaClient', () => {
  it('authenticates once, escapes credentials and paginates by offset', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce(page([item(1), item(2)], 3))
      .mockResolvedValueOnce(page([item(3)], 3));
    const client = new NivodaClient({ ...base, pageSize: 2, fetch: fetchMock });

    const pages = [];
    for await (const p of client.paginate({ origin: 'LAB_GROWN' })) pages.push(p);

    expect(pages.map((p) => p.items.length)).toEqual([2, 1]);
    const queries = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).query as string);
    expect(queries[0]).toContain('username: "u\\"ser"');
    expect(queries[0]).toContain('password: "p\\\\w"');
    expect(queries[1]).toContain('as(token: "tok-1")');
    expect(queries[1]).toContain('labgrown: true');
    expect(queries[1]).toMatch(/offset: 0,\s+limit: 2/);
    expect(queries[2]).toMatch(/offset: 2,/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('re-authenticates once when the token is rejected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce(json({ errors: [{ message: 'Token expired' }] }))
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce(page([item(1)], 1));
    const client = new NivodaClient({ ...base, fetch: fetchMock });
    const result = await client.fetchPage({ origin: 'NATURAL' }, 0);
    expect(result.items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries 429/5xx and network errors, then gives up', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 503))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(authOk());
    const client = new NivodaClient({ ...base, fetch: fetchMock });
    await expect(client.authenticate()).resolves.toBe('tok-1');

    const down = vi.fn().mockImplementation(async () => json({}, 429));
    const failing = new NivodaClient({ ...base, maxRetries: 2, fetch: down });
    await expect(failing.authenticate()).rejects.toThrow(/HTTP 429/);
    expect(down).toHaveBeenCalledTimes(3);
  });

  it('does not retry GraphQL errors', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({ errors: [{ message: 'Invalid credentials' }] }));
    const client = new NivodaClient({ ...base, fetch: fetchMock });
    await expect(client.authenticate()).rejects.toThrow(/Invalid credentials/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ingestNivoda', () => {
  it('upserts both origins, counts rejects and flags unseen stones', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce(page([item(1), item(2, { price: null })], 2)) // natural
      .mockResolvedValueOnce(page([item(3)], 1)); // lab-grown
    const { db, upsert, updateMany } = fakeDb();

    const result = await ingestNivoda(db, { ...base, fetch: fetchMock });

    expect(result).toMatchObject({ fetched: 3, upserted: 2, rejected: 1, markedUnavailable: 3 });
    expect(upsert).toHaveBeenCalledTimes(2);
    const first = upsert.mock.calls[0]?.[0] as { where: unknown; create: { origin: string; syncRunId: string } };
    expect(first.where).toEqual({ source_sourceStockId: { source: 'NIVODA', sourceStockId: 'stone-1' } });
    expect(first.create.syncRunId).toBe(result.syncRunId);
    expect((upsert.mock.calls[1]?.[0] as typeof first).create.origin).toBe('LAB_GROWN');
    expect(updateMany).toHaveBeenCalledOnce();
  });

  it('never flags stones after a failed or partial run', async () => {
    const failing = vi
      .fn()
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce(page([item(1)], 2))
      .mockImplementation(async () => json({ errors: [{ message: 'Internal error' }] }));
    const a = fakeDb();
    await expect(ingestNivoda(a.db, { ...base, pageSize: 1, fetch: failing })).rejects.toThrow(/Internal error/);
    expect(a.updateMany).not.toHaveBeenCalled();

    const partial = vi.fn().mockResolvedValueOnce(authOk()).mockResolvedValueOnce(page([item(1)], 1));
    const b = fakeDb();
    const result = await ingestNivoda(b.db, { ...base, origins: ['NATURAL'], fetch: partial });
    expect(result.markedUnavailable).toBe(0);
    expect(b.updateMany).not.toHaveBeenCalled();
  });
});
