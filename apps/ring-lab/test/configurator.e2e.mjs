/**
 * Browser test for the ring and band builders (configurator/*.html), in headless Chromium.
 * Serves the pages, answers the CDN's three.js requests from node_modules, and drives the
 * choices: the 3D stage must draw, choices must change the design, price and link, and the
 * cart hand-off must carry the design.
 *
 *   pnpm --filter @jewelry/ring-lab test:e2e
 *   SCREENSHOTS=/some/dir node test/configurator.e2e.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../configurator/', import.meta.url));
const modules = fileURLToPath(new URL('../node_modules/', import.meta.url));
const shots = process.env.SCREENSHOTS;
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript' };

const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) return res.writeHead(404).end();
  let body = readFileSync(file);
  // The pages are fragments (the artifact host wraps them); wrap them the same way.
  if (file.endsWith('.html')) body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`;
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: (process.env.RING_LAB_CHROMIUM_ARGS ?? '--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist').split(' ').filter(Boolean) });
let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

async function open(page, { width = 1280, height = 800, touch = false } = {}) {
  const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  await p.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/(.+?)@[^/]+\/(.*)$/, (route) => {
    const [, name, file] = route.request().url().match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/(.+?)@[^/]+\/(.*)$/);
    try { route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(join(modules, name, file)) }); } catch { route.abort(); }
  });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(`${base}/${page}`);
  await p.waitForFunction(() => window.ringBuilder || window.bandBuilder, null, { timeout: 120_000 });
  return { p, errors };
}

/** Share of the stage's pixels that differ from its background, from a finished still. */
const drawnShare = (p, api) => p.evaluate(async (apiName) => {
  const url = await window[apiName].stage.snapshot(2);
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let drawn = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) drawn++;
  return drawn / (d.length / 4);
}, api);


/** Swipes a finger up the middle of an element; returns how far the page and the menu scrolled. */
async function swipeUp(p, selector, menu) {
  const box = await p.locator(selector).first().boundingBox();
  const x = box.x + box.width / 2, y0 = box.y + box.height * 0.8, y1 = box.y + box.height * 0.2;
  const where = () => p.evaluate((m) => ({ page: scrollY, menu: document.querySelector(m).scrollTop, stage: document.querySelector('.stage-wrap').getBoundingClientRect().top }), menu);
  const before = await where();
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 10 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p.waitForTimeout(500);
  const after = await where();
  return { page: after.page - before.page, menu: after.menu - before.menu, stage: after.stage - before.stage };
}

/** On a phone the builder is one screen: the 3D stays at the top and only the menu scrolls. */
async function phoneScreenTests(p, menu) {
  await test('the page itself does not scroll', async () => {
    assert.ok(await p.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1));
  });
  await test('a swipe on the menu scrolls only the menu; the 3D stays put', async () => {
    const moved = await swipeUp(p, menu, menu);
    assert.ok(moved.menu > 50, `menu scrolled ${moved.menu} px`);
    assert.equal(moved.page, 0);
    assert.equal(moved.stage, 0);
  });
  await test('a drag on the 3D turns it and scrolls nothing', async () => {
    const moved = await swipeUp(p, '#stage canvas', menu);
    assert.deepEqual(moved, { page: 0, menu: 0, stage: 0 });
  });
  await test('leaves room for the menu', async () => {
    const room = await p.evaluate((m) => document.querySelector(m).getBoundingClientRect().height, menu);
    assert.ok(room > 200, `${room} px for the menu`);
  });
}

console.log('ring builder');
{
  const { p, errors } = await open('ring-builder.html');
  await p.evaluate(() => window.ringBuilder.stage.setAutoRotate(false));

  await test('draws the ring on the stage', async () => {
    const share = await drawnShare(p, 'ringBuilder');
    assert.ok(share > 0.03 && share < 0.6, `ring covers ${(share * 100).toFixed(1)}% of the stage`);
  });

  await test('a choice changes the design, its heading, the price and the link', async () => {
    const before = await p.evaluate(() => window.ringBuilder.price.total);
    await p.getByRole('radio', { name: 'Oval' }).click();
    await p.getByRole('heading', { name: 'Shape: Oval' }).waitFor();
    assert.equal(await p.evaluate(() => window.ringBuilder.design.specs.centre.shape), 'oval');
    assert.match(await p.evaluate(() => location.hash), /shape=oval/);
    await p.getByRole('radio', { name: '2.00 ct' }).click();
    const after = await p.evaluate(() => window.ringBuilder.price.total);
    assert.ok(after > before, `price ${before} → ${after}`);
    assert.match(await p.locator('#price').textContent(), /\$\d/);
  });

  await test('accent stones appear with a halo, and their choice with them', async () => {
    await p.getByRole('radio', { name: 'Classic', exact: true }).click();
    await p.getByRole('radio', { name: '4 Prong' }).click();
    assert.equal(await p.getByRole('heading', { name: /Accent stones/ }).count(), 0);
    await p.getByRole('radio', { name: 'Halo', exact: true }).click();
    await p.getByRole('heading', { name: /Accent stones/ }).waitFor();
    assert.ok(await p.evaluate(() => window.ringBuilder.design.specs.accents.count) > 10);
  });

  await test('arrow keys move through a group of choices', async () => {
    const ruby = p.getByRole('radiogroup', { name: /Centre stone/ }).getByRole('radio', { name: 'Ruby' });
    await ruby.click();
    await ruby.focus();
    const next = await ruby.evaluate((b) => b.nextElementSibling.dataset.value);
    await p.keyboard.press('ArrowRight');
    assert.equal(await p.evaluate(() => window.ringBuilder.state.gem), next);
  });

  await test('a shared link opens the same design', async () => {
    const hash = await p.evaluate(() => location.hash);
    const other = await open(`ring-builder.html${hash}`);
    const [a, b] = await Promise.all([p.evaluate(() => window.ringBuilder.state), other.p.evaluate(() => window.ringBuilder.state)]);
    assert.deepEqual(b, a);
    await other.p.close();
  });

  await test('add to cart hands over the design, specs and price', async () => {
    const detail = await p.evaluate(() => new Promise((resolve) => {
      window.addEventListener('ring-builder:add-to-cart', (e) => resolve(e.detail), { once: true });
      document.getElementById('add').click();
    }));
    assert.equal(detail.design.shape, 'oval');
    assert.ok(detail.specs.metal.grams > 1);
    assert.equal(detail.price.total, await p.evaluate(() => window.ringBuilder.price.total));
  });

  if (shots) await p.screenshot({ path: join(shots, 'ring-builder.png') });
  await test('no errors on the page', async () => assert.deepEqual(errors, []));
  await p.close();
}

console.log('ring builder on a phone');
{
  const { p, errors } = await open('ring-builder.html', { width: 375, height: 667, touch: true });
  await test('fits the screen without scrolling sideways', async () => {
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
  });
  await phoneScreenTests(p, '.panel');
  if (shots) await p.screenshot({ path: join(shots, 'ring-builder-phone.png') });
  await test('no errors on the page', async () => assert.deepEqual(errors, []));
  await p.close();
}

console.log('band builder');
{
  const { p, errors } = await open('band-builder.html');
  await p.evaluate(() => window.bandBuilder.stage.setAutoRotate(false));

  await test('draws both bands on the stage', async () => {
    const share = await drawnShare(p, 'bandBuilder');
    assert.ok(share > 0.03 && share < 0.6, `bands cover ${(share * 100).toFixed(1)}% of the stage`);
  });

  await test('linked rings share design choices but not sizes', async () => {
    await p.getByRole('radio', { name: 'Dome' }).click();
    assert.equal(await p.evaluate(() => window.bandBuilder.state.his.profile), 'dome');
    await p.getByRole('tab', { name: "Men's", exact: true }).click();
    await p.getByLabel('Ring size').selectOption('64');
    assert.equal(await p.evaluate(() => window.bandBuilder.state.her.size), 52);
    await p.getByRole('button', { name: 'Design both rings together' }).click();
    assert.equal(await p.evaluate(() => window.bandBuilder.state.linked), false);
    await p.getByRole('radio', { name: 'Flat', exact: true }).click();
    assert.equal(await p.evaluate(() => window.bandBuilder.state.her.profile), 'dome');
    assert.equal(await p.evaluate(() => window.bandBuilder.state.his.profile), 'flat');
  });

  await test('width moves in steps of 0.1 mm', async () => {
    const before = await p.evaluate(() => window.bandBuilder.state.his.width);
    await p.getByRole('button', { name: 'Wider by 0.1 mm' }).click();
    await p.getByRole('button', { name: 'Wider by 0.1 mm' }).click();
    await p.getByRole('button', { name: 'Narrower by 0.1 mm' }).click();
    assert.equal(await p.evaluate(() => window.bandBuilder.state.his.width), Math.round((before + 0.1) * 10) / 10);
  });

  await test('steps lead to the inscription, which is priced', async () => {
    await p.getByRole('button', { name: 'Next: Metal & finish' }).click();
    await p.getByRole('radio', { name: 'Hammered' }).first().click();
    await p.getByRole('radio', { name: '3', exact: true }).click();
    assert.equal(await p.evaluate(() => window.bandBuilder.designs.his.specs.sections), 3);
    await p.getByRole('radio', { name: 'Milgrain' }).click();
    assert.equal(await p.evaluate(() => window.bandBuilder.state.his.edge), 'milgrain');
    await p.getByRole('button', { name: 'Next: Stones' }).click();
    await p.getByRole('radio', { name: 'Row along' }).click();
    await p.getByRole('radio', { name: 'Channel' }).click();
    await p.getByRole('radio', { name: 'All round' }).click();
    assert.ok(await p.evaluate(() => window.bandBuilder.designs.his.specs.stones.count) > 20);
    await p.getByRole('button', { name: 'Next: Inscription' }).click();
    await p.getByLabel('Engraving text').fill('Always');
    await p.waitForFunction(() => window.bandBuilder.designs.his.specs.engraving === 'Always');
    assert.ok(await p.evaluate(() => window.bandBuilder.prices.his.lines.some((l) => l.key === 'engraving')));
    const total = await p.evaluate(() => window.bandBuilder.prices.her.total + window.bandBuilder.prices.his.total);
    assert.equal((await p.locator('#total').textContent()).replace(/\D/g, ''), String(total));
  });

  await test('add to cart hands over both rings', async () => {
    const detail = await p.evaluate(() => new Promise((resolve) => {
      window.addEventListener('band-builder:add-to-cart', (e) => resolve(e.detail), { once: true });
      document.getElementById('next').click();
    }));
    assert.equal(detail.his.design.engraving, 'Always');
    assert.ok(detail.her.specs.grams > 1 && detail.his.specs.grams > 1);
  });

  if (shots) await p.screenshot({ path: join(shots, 'band-builder.png') });
  await test('no errors on the page', async () => assert.deepEqual(errors, []));
  await p.close();
}

console.log('band builder on a phone');
{
  const { p, errors } = await open('band-builder.html', { width: 375, height: 667, touch: true });
  await test('fits the screen without scrolling sideways', async () => {
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
  });
  await phoneScreenTests(p, '.scroller');
  if (shots) await p.screenshot({ path: join(shots, 'band-builder-phone.png') });
  await test('no errors on the page', async () => assert.deepEqual(errors, []));
  await p.close();
}

await browser.close();
server.close();
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log('all passed');
