import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { practiceDiamonds, siteHosts } from '../scripts/practice-store';
import { findManifest, loadRemoteManifest } from '../src/services/renders';

describe('practice store', () => {
  it('has a spread of sample diamonds priced like wholesale', () => {
    const stones = practiceDiamonds();
    expect(stones).toHaveLength(48);
    expect(new Set(stones.map((s) => s.sourceStockId)).size).toBe(48);
    expect(stones.every((s) => String(s.sourceStockId).startsWith('practice-') && String(s.certificateNumber).startsWith('PRACTICE-'))).toBe(true);
    expect(new Set(stones.map((s) => s.shape)).size).toBeGreaterThanOrEqual(8);
    expect(stones.some((s) => s.origin === 'LAB_GROWN') && stones.some((s) => s.origin === 'NATURAL')).toBe(true);
    for (const s of stones) {
      const carat = Number(s.carat), perCarat = Number(s.wholesalePrice) / carat;
      // Natural: about $1,500–40,000 a carat; lab-grown far less.
      if (s.origin === 'NATURAL') expect(perCarat, String(s.sourceStockId)).toBeGreaterThan(1500);
      else expect(perCarat, String(s.sourceStockId)).toBeLessThan(4000);
      expect(perCarat).toBeLessThan(40000);
    }
  });

  it('works from the site and its www twin', () => {
    expect(siteHosts('my-shop.com')).toEqual({ url: 'https://my-shop.com', hosts: ['my-shop.com', 'www.my-shop.com'] });
    expect(siteHosts('https://www.my-shop.com/ring-builder/')).toEqual({ url: 'https://www.my-shop.com', hosts: ['www.my-shop.com', 'my-shop.com'] });
  });
});

describe('render manifests from where the renders are published', () => {
  let base = '', hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === '/renders/catalog/media/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ metals: {}, colours: {}, combos: [{ id: 'round-halo', variants: {} }] }));
    } else res.writeHead(404).end();
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/renders`;
  });
  afterAll(() => server.close());

  it('reads the manifest over the network when there is no copy on disk, and keeps it', async () => {
    const m = await findManifest({ rendersPublicUrl: base }, 'catalog');
    expect(m?.combos[0]?.id).toBe('round-halo');
    const before = hits;
    await loadRemoteManifest(base, 'catalog');
    expect(hits).toBe(before);
  });

  it('gives null for a collection that is not there (and does not ask again at once)', async () => {
    expect(await loadRemoteManifest(base, 'missing')).toBeNull();
    const before = hits;
    expect(await loadRemoteManifest(base, 'missing')).toBeNull();
    expect(hits).toBe(before);
  });
});
