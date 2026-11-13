/**
 * Browser test for <jewelry-configurator>. Loads the built bundle into a host
 * page whose CSS is deliberately hostile, mocks the storefront API, and walks
 * the wizard through all three cart hand-offs.
 *
 *   pnpm --filter @jewelry/widget test:e2e          (builds first)
 *   SCREENSHOTS=/some/dir node test/e2e.mjs          (also writes screenshots)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = readFileSync(join(here, '../dist/jewelry-configurator.js'));
// A classic script is decoded with the host page's encoding, so the bundle must be ASCII.
assert.equal(bundle.findIndex((byte) => byte > 127), -1, 'bundle contains non-ASCII bytes');
const API = 'https://api.ringbuilder.test';
const shots = process.env.SCREENSHOTS;

// ── Fixtures ──
const svg = (label, bg) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="${bg}"/><circle cx="100" cy="110" r="52" fill="none" stroke="#b9b2a3" stroke-width="9"/><path d="M82 58l18-18 18 18-18 20z" fill="#fff" stroke="#999"/><text x="100" y="190" font-size="12" text-anchor="middle" fill="#777">${label}</text></svg>`)}`;
const img = (name) => `https://cdn.ringbuilder.test/${name}.svg`;
const usd = (amount) => ({ amount: amount.toFixed(2), currency: 'USD' });
const variant = (id, metal, price) => ({ id, metal, metalWeightGrams: 3.2, video360Url: null, imageUrls: [img(`${id}`)], price: usd(price) });
const SETTINGS = [
  { id: 'set-1', sku: 'SOL-1', name: 'Classic Solitaire', description: null, style: 'SOLITAIRE', compatibleShapes: ['ROUND', 'OVAL'], centerCarat: { min: 0.5, max: 3 }, ringSize: { min: 4, max: 9 }, leadTimeDays: 14, video360Url: 'https://v360.ringbuilder.test/sol-1', thumbnailUrl: img('sol'), sideStones: [], variants: [variant('v-wg', 'WHITE_GOLD_14K', 1000), variant('v-pt', 'PLATINUM_950', 2000)], priceFrom: usd(1000) },
  { id: 'set-2', sku: 'HALO-1', name: 'Round Halo', description: null, style: 'HALO', compatibleShapes: ['ROUND'], centerCarat: { min: 0.9, max: 1.2 }, ringSize: { min: null, max: null }, leadTimeDays: null, video360Url: null, thumbnailUrl: img('halo'), sideStones: [], variants: [variant('v-halo', 'PLATINUM_950', 1500)], priceFrom: usd(1500) },
  { id: 'set-3', sku: 'XSS', name: '<img src=x onerror="window.__xss=1">Vintage', description: null, style: 'VINTAGE', compatibleShapes: ['ROUND'], centerCarat: { min: 0.5, max: 2 }, ringSize: { min: 4, max: 9 }, leadTimeDays: null, video360Url: 'javascript:window.__xss=1', thumbnailUrl: 'javascript:window.__xss=1', sideStones: [], variants: [variant('v-vin', 'ROSE_GOLD_14K', 1200)], priceFrom: usd(1200) },
];
const DIAMONDS = Array.from({ length: 30 }, (_, i) => ({
  id: `dia-${i + 1}`, inventory: i === 2 ? 'MERCHANT' : 'FEED', origin: i % 2 ? 'LAB_GROWN' : 'NATURAL', shape: i % 3 ? 'ROUND' : 'OVAL',
  carat: 0.7 + i * 0.05, color: 'DEFGHIJ'[i % 7], clarity: ['VVS1', 'VS1', 'VS2', 'SI1'][i % 4], cut: 'EXCELLENT', polish: 'EXCELLENT', symmetry: 'EXCELLENT', fluorescence: 'NONE',
  lab: 'GIA', certificateNumber: `21414${i}`, certificateUrl: `https://www.gia.edu/report-check?reportno=21414${i}`,
  measurements: { lengthMm: 6.4, widthMm: 6.4, depthMm: 3.9, lwRatio: 1 }, imageUrl: img(`dia-${i + 1}`), videoUrl: `https://v360.ringbuilder.test/dia-${i + 1}`, deliveryDays: 7, price: usd(1500 + i * 210.5),
}));

// ── Host store ──
const calls = { cartAdd: [], wcAjax: [], paid: 0 };
const hostPage = (globals) => `<!doctype html><html lang="en"><head><meta charset="windows-1252"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  /* A theme that would wreck any unprotected widget. */
  * { font-family: "Comic Sans MS", cursive !important; color: red !important; box-sizing: content-box !important; }
  body { margin: 0; padding: 24px; font-size: 30px; line-height: 3; text-transform: uppercase; letter-spacing: 6px; text-align: center; background: #efe9dc; }
  button, select, input { display: none !important; }
  h2 { font-size: 90px !important; margin: 200px !important; }
  div, section, article, li, ol, ul, footer, nav { float: right !important; width: 10px !important; border: 5px solid lime !important; }
  img { width: 5px !important; height: 5px !important; }
</style></head>
<body><h1>Hostile Store</h1>
<script>${globals}</script>
<script src="/jewelry-configurator.js"></script>
<jewelry-configurator api-base="${API}" api-key="pk_test_123" locale="en-US"></jewelry-configurator>
</body></html>`;

let pageGlobals = '';
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    const text = Buffer.concat(body).toString();
    if (url.pathname === '/jewelry-configurator.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle);
    if (url.pathname === '/cart/add.js') {
      calls.cartAdd.push(JSON.parse(text));
      return res.writeHead(200, { 'content-type': 'application/json' }).end('{"items":[]}');
    }
    if (url.searchParams.get('wc-ajax') === 'add_to_cart') {
      calls.wcAjax.push(Object.fromEntries(new URLSearchParams(text)));
      return res.writeHead(200, { 'content-type': 'application/json' }).end('{"fragments":{"div.cart":"<div>1</div>"},"cart_hash":"abc"}');
    }
    if (url.pathname === '/pay') {
      calls.paid++;
      return res.writeHead(200, { 'content-type': 'text/html' }).end('<h1 id="pay">Pay here</h1>');
    }
    if (url.pathname === '/cart') return res.writeHead(200, { 'content-type': 'text/html' }).end('<h1 id="cart">Cart</h1>');
    res.writeHead(200, { 'content-type': 'text/html; charset=windows-1252' }).end(hostPage(pageGlobals));
  });
});
await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

// ── Mock API ──
const api = { requests: [], platform: 'SHOPIFY', failCartItem: null, soldOut: false };
async function mockApi(page) {
  await page.route(/cdn\.ringbuilder\.test/, (route) => {
    const name = new URL(route.request().url()).pathname.slice(1, -4);
    route.fulfill({ contentType: 'image/svg+xml', body: decodeURIComponent(svg(name, name.startsWith('dia') ? '#eef3f7' : '#f1ece2').split(',')[1]) });
  });
  await page.route(/v360\.ringbuilder\.test/, (route) => route.fulfill({ contentType: 'text/html', body: '<body style="margin:0;display:grid;place-items:center;height:100vh;font:20px sans-serif">360° viewer</body>' }));
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const cors = { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type,x-api-key', 'access-control-expose-headers': 'x-cache' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const q = Object.fromEntries(url.searchParams);
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    api.requests.push({ method: req.method(), path: url.pathname, q, body, key: req.headers()['x-api-key'] });
    const json = (status, data) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(data) });

    if (url.pathname === '/api/v1/settings') {
      const data = SETTINGS.filter((s) => (!q.style || s.style === q.style) && (!q.metal || s.variants.some((v) => v.metal === q.metal)))
        .map((s) => (q.metal ? { ...s, variants: s.variants.filter((v) => v.metal === q.metal) } : s));
      return json(200, { data, page: 1, limit: 60, total: data.length, hasMore: false });
    }
    if (url.pathname === '/api/v1/diamonds') {
      const shapes = q.shape?.split(',') ?? [];
      const colors = q.color?.split(',');
      let data = DIAMONDS.filter((d) => shapes.includes(d.shape) && d.carat >= +q.caratMin - 1e-9 && d.carat <= +q.caratMax + 1e-9 && (!q.origin || d.origin === q.origin) && (!colors || colors.includes(d.color)) && (!q.priceMax || +d.price.amount <= +q.priceMax) && (!q.priceMin || +d.price.amount >= +q.priceMin));
      if (q.sort === 'price_desc') data = [...data].reverse();
      const page = +q.page || 1, limit = +q.limit || 24;
      return json(200, { data: data.slice((page - 1) * limit, page * limit), page, limit, total: data.length, totalCapped: false, hasMore: page * limit < data.length });
    }
    if (url.pathname === '/api/v1/bundle') {
      if (api.soldOut) return json(409, { error: { code: 'diamond_unavailable', message: 'This diamond is no longer available.' } });
      const v = SETTINGS.flatMap((s) => s.variants).find((x) => x.id === body.settingVariantId);
      const d = DIAMONDS.find((x) => x.id === body.diamondId);
      return json(200, { bundleId: 'b-1', expiresAt: 1, token: 'tok.sig', lineItem: { title: 'Classic Solitaire in 14K White Gold with 0.75ct Round Diamond', sku: 'SOL-1', price: usd(+v.price.amount + +d.price.amount), imageUrl: null, properties: {} } });
    }
    if (url.pathname === '/api/v1/cart-item') {
      if (api.failCartItem) return json(api.failCartItem.status, { error: api.failCartItem });
      return json(200, { bundleId: 'b-1', platform: api.platform, purchasableId: '9001', quantity: 1, properties: { Metal: '14K White Gold', _bundle_id: 'b-1' } });
    }
    if (url.pathname === '/api/v1/checkout') return json(200, { bundleId: 'b-1', checkoutUrl: `${origin}/pay` });
    return json(404, { error: { code: 'not_found', message: 'nope' } });
  });
}

// ── Helpers ──
const browser = await chromium.launch();
let passed = 0;
async function scenario(name, { globals = '', viewport = { width: 1200, height: 900 } }, run) {
  pageGlobals = globals;
  api.requests = []; api.platform = 'SHOPIFY'; api.failCartItem = null; api.soldOut = false;
  const context = await browser.newContext({ viewport, deviceScaleFactor: shots ? 2 : 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mockApi(page);
  await page.goto(origin);
  try {
    await run(page);
    assert.deepEqual(errors, [], 'no uncaught page errors');
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    if (shots) await page.screenshot({ path: join(shots, `FAILED-${name.replace(/\W+/g, '-')}.png`), fullPage: true });
    console.error(`  ✗ ${name}\n`, err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}
const w = (page) => page.locator('jewelry-configurator');
const shot = async (page, name) => shots && (await page.screenshot({ path: join(shots, `${name}.png`) }));
const setRange = (locator, value) => locator.evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
const lastDiamondQuery = () => api.requests.filter((r) => r.path === '/api/v1/diamonds').at(-1).q;
async function buildRing(page) {
  await w(page).getByRole('button', { name: /Classic Solitaire/ }).click();
  await w(page).getByRole('button', { name: 'Choose a diamond', exact: true }).click();
  await w(page).getByRole('button', { name: /^Select 0\.75 ct Round/ }).click();
  await w(page).getByRole('button', { name: 'Review ring', exact: true }).click();
  await w(page).getByRole('heading', { name: 'Review your ring' }).waitFor();
}

console.log('jewelry-configurator e2e');

await scenario('survives hostile host CSS and never runs catalogue data as markup', {}, async (page) => {
  await w(page).getByRole('heading', { name: 'Choose your setting' }).waitFor();
  await w(page).getByRole('button', { name: /Classic Solitaire/ }).waitFor();
  const styles = await page.evaluate(() => {
    const root = document.querySelector('jewelry-configurator').shadowRoot;
    const cs = (sel) => getComputedStyle(root.querySelector(sel));
    return {
      h2Size: cs('h2').fontSize, h2Margin: cs('h2').marginTop, font: cs('h2').fontFamily, color: cs('h2').color,
      transform: cs('h2').textTransform, spacing: cs('.card-name').letterSpacing, align: cs('h2').textAlign, lineHeight: cs('.card-name').lineHeight,
      buttonDisplay: cs('.card-main').display, selectDisplay: cs('select').display, gridFloat: cs('.grid').float, sizing: cs('.card').boxSizing,
      cardWidth: root.querySelector('.card').getBoundingClientRect().width, imgWidth: root.querySelector('.thumb img').getBoundingClientRect().width,
      border: cs('.grid').borderTopWidth,
    };
  });
  assert.equal(styles.h2Size, '21.6px');
  assert.equal(styles.h2Margin, '0px');
  assert.doesNotMatch(styles.font, /Comic/);
  assert.equal(styles.color, 'rgb(28, 27, 26)');
  assert.equal(styles.transform, 'none');
  assert.equal(styles.spacing, 'normal');
  assert.notEqual(styles.align, 'center');
  assert.equal(styles.lineHeight, '23.2px');
  assert.notEqual(styles.buttonDisplay, 'none');
  assert.notEqual(styles.selectDisplay, 'none');
  assert.equal(styles.gridFloat, 'none');
  assert.equal(styles.sizing, 'border-box');
  assert.equal(styles.border, '0px');
  assert.ok(styles.cardWidth > 150, `card width ${styles.cardWidth}`);
  assert.ok(styles.imgWidth > 100, `image width ${styles.imgWidth}`);
  // a long unbroken name must not stretch its card
  const widths = await page.evaluate(() => [...document.querySelector('jewelry-configurator').shadowRoot.querySelectorAll('.card')].map((c) => Math.round(c.getBoundingClientRect().width)));
  assert.equal(new Set(widths).size, 1, `card widths ${widths}`);
  // and the widget's styles do not leak out
  assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('h1')).fontFamily), /Comic/);

  // hostile catalogue data is shown as text, and non-https URLs are dropped
  await w(page).getByText('<img src=x onerror="window.__xss=1">Vintage').waitFor();
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.evaluate(() => [...document.querySelector('jewelry-configurator').shadowRoot.querySelectorAll('[src],[href]')].filter((e) => /^javascript:/i.test(e.getAttribute('src') ?? e.getAttribute('href'))).length), 0);
  assert.equal(api.requests[0].key, 'pk_test_123');
  await shot(page, '1-settings-desktop');
});

await scenario('step 1 filters settings by metal and style', {}, async (page) => {
  await w(page).getByRole('button', { name: /Classic Solitaire/ }).waitFor();
  await w(page).getByLabel('Metal').selectOption('PLATINUM_950');
  await w(page).getByRole('button', { name: /Round Halo/ }).waitFor();
  assert.equal(await w(page).locator('.card').count(), 2);
  assert.equal(api.requests.at(-1).q.metal, 'PLATINUM_950');
  await w(page).getByRole('button', { name: 'Halo', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('jewelry-configurator').shadowRoot.querySelectorAll('.card').length === 1);
  assert.deepEqual({ metal: api.requests.at(-1).q.metal, style: api.requests.at(-1).q.style }, { metal: 'PLATINUM_950', style: 'HALO' });
  // nothing chosen yet: cannot continue
  assert.ok(await w(page).getByRole('button', { name: 'Choose a diamond', exact: true }).isDisabled());
  await w(page).getByRole('button', { name: 'Vintage', exact: true }).click();
  await w(page).getByText('No settings match these filters.').waitFor();
});

await scenario('step 2 searches diamonds with shape, carat, colour and price sliders', {}, async (page) => {
  await w(page).getByRole('button', { name: /Classic Solitaire/ }).click();
  await w(page).getByRole('button', { name: 'Platinum 950' }).click(); // metal swatch
  await w(page).getByText('Platinum 950 · $2,000').waitFor();
  await w(page).getByRole('button', { name: 'Choose a diamond', exact: true }).click();
  await w(page).getByText('30 diamonds').waitFor();
  // first search is limited to what the setting can hold
  assert.deepEqual(
    { shape: lastDiamondQuery().shape, caratMin: lastDiamondQuery().caratMin, caratMax: lastDiamondQuery().caratMax, limit: lastDiamondQuery().limit },
    { shape: 'ROUND,OVAL', caratMin: '0.5', caratMax: '3', limit: '24' },
  );
  assert.equal(await w(page).locator('.stone').count(), 24);
  await shot(page, '2-diamonds-desktop');

  await w(page).getByRole('button', { name: 'Show more diamonds' }).click();
  await page.waitForFunction(() => document.querySelector('jewelry-configurator').shadowRoot.querySelectorAll('.stone').length === 30);
  assert.equal(lastDiamondQuery().page, '2');

  await w(page).getByRole('button', { name: 'Oval', exact: true }).click();
  await w(page).getByText('10 diamonds').waitFor();
  assert.equal(lastDiamondQuery().shape, 'OVAL');

  await setRange(w(page).getByLabel('Maximum carat'), 1.5);
  await setRange(w(page).getByLabel('Minimum colour'), 1);
  await setRange(w(page).getByLabel('Maximum colour'), 3);
  await setRange(w(page).getByLabel('Maximum price'), 10); // $5,000
  await w(page).getByText('E – G').waitFor();
  await w(page).getByText('$0 – $5,000').waitFor();
  await page.waitForFunction(() => /^\d diamonds?$/.test(document.querySelector('jewelry-configurator').shadowRoot.querySelector('.results-head span').textContent.trim()));
  const q = lastDiamondQuery();
  assert.deepEqual({ caratMax: q.caratMax, color: q.color, priceMax: q.priceMax, priceMin: q.priceMin, page: q.page }, { caratMax: '1.5', color: 'E,F,G', priceMax: '5000', priceMin: undefined, page: '1' });

  // thumbs cannot cross
  await setRange(w(page).getByLabel('Minimum carat'), 2.5);
  await w(page).getByText('1.50 ct – 1.50 ct').waitFor();

  await w(page).getByLabel('Sort by').selectOption('price_desc');
  await page.waitForFunction(() => true);
  await w(page).getByRole('button', { name: 'Lab-Grown' }).click();
  await page.waitForTimeout(400);
  assert.deepEqual({ sort: lastDiamondQuery().sort, origin: lastDiamondQuery().origin }, { sort: 'price_desc', origin: 'LAB_GROWN' });
});

await scenario('Shopify: adds the priced variant through /cart/add.js', { globals: 'window.Shopify = { shop: "x.myshopify.com", routes: { root: "/" } };' }, async (page) => {
  await buildRing(page);
  await w(page).getByText('$2,710.50').first().waitFor(); // setting 1000 + diamond 1710.50
  await w(page).getByLabel('Ring size').selectOption('7.5');
  await w(page).getByLabel(/Engraving/).fill('Forever');
  await w(page).getByRole('button', { name: 'View in 360°' }).click();
  await w(page).locator('.hero iframe').waitFor();
  await w(page).getByRole('button', { name: 'Show photo' }).click();
  await shot(page, '3-review-desktop');
  await w(page).getByRole('button', { name: 'Add to Cart' }).click();
  await w(page).getByRole('heading', { name: 'Added to your cart' }).waitFor();

  const bundleReq = api.requests.find((r) => r.path === '/api/v1/bundle').body;
  assert.deepEqual(bundleReq, { settingVariantId: 'v-wg', diamondId: 'dia-2', inventory: 'FEED', ringSize: 7.5, engraving: 'Forever' });
  assert.deepEqual(api.requests.find((r) => r.path === '/api/v1/cart-item').body, { token: 'tok.sig' });
  assert.deepEqual(calls.cartAdd.at(-1), { items: [{ id: 9001, quantity: 1, properties: { Metal: '14K White Gold', _bundle_id: 'b-1' } }] });
  assert.equal(api.requests.some((r) => r.path === '/api/v1/checkout'), false);
  assert.equal(await w(page).getByRole('link', { name: 'View cart' }).getAttribute('href'), '/cart');
  await shot(page, '4-added-desktop');
  await w(page).getByRole('button', { name: 'Build another ring' }).click();
  await w(page).getByRole('heading', { name: 'Choose your setting' }).waitFor();
});

await scenario('WooCommerce: adds the product through wc-ajax and refreshes cart fragments', {
  globals: 'window.wc_add_to_cart_params = { wc_ajax_url: "/?wc-ajax=%%endpoint%%", cart_url: "/cart" }; window.__triggered = []; window.jQuery = () => ({ trigger: (e, a) => window.__triggered.push([e, a]) });',
}, async (page) => {
  api.platform = 'WOOCOMMERCE';
  await page.evaluate(() => document.addEventListener('jc-added-to-cart', (e) => (window.__event = e.detail)));
  await buildRing(page);
  await w(page).getByRole('button', { name: 'Add to Cart' }).click();
  await w(page).getByRole('heading', { name: 'Added to your cart' }).waitFor();
  assert.deepEqual(calls.wcAjax.at(-1), { product_id: '9001', quantity: '1' });
  const triggered = await page.evaluate(() => window.__triggered);
  assert.equal(triggered[0][0], 'added_to_cart');
  assert.deepEqual(triggered[0][1][0], { 'div.cart': '<div>1</div>' });
  const event = await page.evaluate(() => window.__event);
  assert.deepEqual({ platform: event.platform, cartUrl: event.cartUrl, bundleId: event.bundleId }, { platform: 'WOOCOMMERCE', cartUrl: '/cart', bundleId: 'b-1' });
});

await scenario('other sites, and a failing native cart, fall back to hosted checkout', {}, async (page) => {
  await buildRing(page);
  await w(page).getByRole('button', { name: 'Add to Cart' }).click();
  await page.locator('#pay').waitFor();
  assert.equal(api.requests.some((r) => r.path === '/api/v1/cart-item'), false, 'no native attempt on an unknown platform');

  // Shopify storefront, but the store's product API refuses
  await page.goto(origin);
  await page.evaluate(() => (window.Shopify = { shop: 'x', routes: { root: '/' } }));
  api.failCartItem = { status: 502, code: 'platform_error', message: 'nope' };
  const before = calls.cartAdd.length;
  await buildRing(page);
  await w(page).getByRole('button', { name: 'Add to Cart' }).click();
  await page.locator('#pay').waitFor();
  assert.equal(calls.cartAdd.length, before);
});

await scenario('a diamond that sold meanwhile is reported and removed', {}, async (page) => {
  await buildRing(page);
  api.soldOut = true;
  await w(page).getByRole('button', { name: 'Add to Cart' }).click();
  await w(page).getByRole('alert').getByText('This diamond is no longer available.').waitFor();
  assert.ok(await w(page).getByRole('button', { name: 'Add to Cart' }).isDisabled());
  await w(page).getByRole('button', { name: 'Choose another diamond' }).click();
  await w(page).getByRole('heading', { name: 'Choose your diamond' }).waitFor();
  assert.equal(await w(page).getByRole('button', { name: /^Select 0\.75 ct Round/ }).count(), 0);
  assert.ok(await w(page).getByRole('button', { name: 'Review ring', exact: true }).isDisabled());
});

await scenario('phone-width layout has no horizontal overflow', { viewport: { width: 390, height: 844 } }, async (page) => {
  const overflow = () => page.evaluate(() => {
    const host = document.querySelector('jewelry-configurator');
    const wide = [...host.shadowRoot.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > host.getBoundingClientRect().right + 1 && getComputedStyle(el).position !== 'absolute');
    return wide.map((el) => el.className || el.tagName).slice(0, 5);
  });
  await w(page).getByRole('button', { name: /Classic Solitaire/ }).click();
  assert.deepEqual(await overflow(), []);
  await shot(page, '1-settings-phone');
  await w(page).getByRole('button', { name: 'Choose a diamond', exact: true }).click();
  await w(page).getByText('30 diamonds').waitFor();
  assert.deepEqual(await overflow(), []);
  await shot(page, '2-diamonds-phone');
  await w(page).getByRole('button', { name: /^Select 0\.75 ct Round/ }).click();
  await w(page).getByRole('button', { name: 'Review ring', exact: true }).click();
  await w(page).getByRole('heading', { name: 'Review your ring' }).waitFor();
  assert.deepEqual(await overflow(), []);
  // tap targets
  const small = await page.evaluate(() => [...document.querySelector('jewelry-configurator').shadowRoot.querySelectorAll('.btn, select, input[type=text]')].filter((el) => el.getBoundingClientRect().height < 36).length);
  assert.equal(small, 0);
  await shot(page, '3-review-phone');
});

await browser.close();
server.close();
console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
