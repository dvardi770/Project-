/**
 * Browser test of the dashboard: the built Next.js app, a real Postgres, and a
 * local stand-in for Stripe.
 *
 *   TEST_DATABASE_URL=postgresql://… pnpm --filter @jewelry/dashboard test:e2e
 *   SCREENSHOTS=/some/dir …            (also writes screenshots)
 *
 * The database is emptied first: point it at a disposable one.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PrismaClient } from '@jewelry/db';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  console.error('TEST_DATABASE_URL is required');
  process.exit(2);
}
const shots = process.env.SCREENSHOTS;
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PORT = 3111;
const APP = `http://localhost:${PORT}`;
const SECRET_KEY = 'sk_test_dashboard_e2e_key';
const WHSEC = 'whsec_e2e';

// ── Seed ──
const db = new PrismaClient({ datasourceUrl: databaseUrl });
await db.$executeRawUnsafe(
  'TRUNCATE "tenants", "diamond_cache", "virtual_settings", "casting_vendors", "custom_merchant_stock" RESTART IDENTITY CASCADE',
);
const tenant = await db.tenant.create({
  data: {
    name: 'Example Jewelers',
    slug: 'example-jewelers',
    platformType: 'WOOCOMMERCE',
    subscriptionStatus: 'TRIALING',
    trialEndsAt: new Date('2026-12-01T00:00:00Z'),
    apiKeys: {
      create: { type: 'SECRET', prefix: 'sk_test_dash', keyHash: createHash('sha256').update(SECRET_KEY).digest('hex') },
    },
  },
});
const setting = await db.virtualSetting.create({
  data: {
    sku: 'SOL-1',
    name: 'Classic Solitaire',
    style: 'SOLITAIRE',
    compatibleShapes: ['ROUND', 'OVAL'],
    centerCaratMin: '0.5',
    centerCaratMax: '3',
    cadId: 'CAD-1',
    variants: { create: { metal: 'WHITE_GOLD_14K', castingCost: '400' } },
  },
  include: { variants: true },
});
const order = (n: number, status: 'CONFIRMED' | 'ON_HOLD', total: string, stone: object, extra: object = {}) =>
  db.castingOrder.create({
    data: {
      tenantId: tenant.id,
      jobBagNumber: `JB-261113-00000${n}`,
      status,
      currentStage: 'CAD_PREP',
      externalOrderId: `50${n}`,
      settingVariantId: setting.variants[0]!.id,
      metal: 'WHITE_GOLD_14K',
      cadId: 'CAD-1',
      ringSize: '6.5',
      centerStoneSnapshot: stone,
      castingCost: '400',
      stoneCost: '800',
      retailTotal: total,
      createdAt: new Date(Date.UTC(2026, 10, 10 + n)),
      routeSteps: { create: ['CAD_PREP', 'WAX_PRINT', 'CASTING', 'STONE_SETTING'].map((stage, i) => ({ sequence: i + 1, stage: stage as 'CAD_PREP' })) },
      ...extra,
    },
  });
await order(1, 'CONFIRMED', '2600.99', { carat: '1.5', shape: 'OVAL', origin: 'LAB_GROWN', color: 'G', clarity: 'VS1' }, { engraving: 'Forever' });
await order(2, 'ON_HOLD', '4000.00', { carat: '1.2', shape: 'ROUND', origin: 'NATURAL', color: 'F', clarity: 'VS2' }, {
  notes: 'Paid 10.00 but the bundle was quoted at 4000.00.',
});

// ── Stand-in for Stripe ──
const stripeCalls: { path: string; body: Record<string, string> }[] = [];
const stripe = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const path = req.url ?? '';
    stripeCalls.push({ path, body: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())) });
    const json = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (path === '/v1/checkout/sessions') return json({ url: `http://localhost:${stripePort}/pay` });
    if (path === '/v1/billing_portal/sessions') return json({ url: `http://localhost:${stripePort}/portal` });
    if (path === '/v1/subscriptions/sub_e2e') {
      return json({ id: 'sub_e2e', customer: 'cus_e2e', status: 'active', items: { data: [{ current_period_end: 1797120000 }] }, metadata: { tenant_id: tenant.id } });
    }
    if (path === '/pay') return res.writeHead(200, { 'content-type': 'text/html' }).end('<h1 id="stripe-checkout">Stripe Checkout</h1>');
    if (path === '/portal') return res.writeHead(200, { 'content-type': 'text/html' }).end('<h1 id="stripe-portal">Stripe Billing Portal</h1>');
    res.writeHead(404).end();
  });
});
await new Promise<void>((r) => stripe.listen(0, r));
const stripePort = (stripe.address() as { port: number }).port;

// ── The app ──
// Started with node directly (not through npx) so that stopping it stops the server itself.
const next = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(PORT)], {
  cwd: join(here, '..'),
  env: {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl,
    DASHBOARD_URL: APP,
    SESSION_SECRET: 'e2e-session-secret-e2e-session-secret-123',
    STRIPE_SECRET_KEY: 'sk_test_stripe',
    STRIPE_PRICE_ID: 'price_e2e',
    STRIPE_WEBHOOK_SECRET: WHSEC,
    STRIPE_API_BASE: `http://localhost:${stripePort}`,
    BILLING_PRICE_USD: '99.00',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
next.stdout.on('data', (d: Buffer) => (serverLog += d));
next.stderr.on('data', (d: Buffer) => (serverLog += d));
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${APP}/login`)).ok) break;
  } catch {
    /* not up yet */
  }
  if (i > 60) throw new Error(`dashboard did not start:\n${serverLog}`);
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: shots ? 2 : 1 });
const page = await context.newPage();
const pageErrors: string[] = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const shot = async (name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `dashboard-${name}.png`), fullPage: true });
};
let passed = 0;
const step = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

try {
  console.log('dashboard e2e');

  // ── Sign-in ──
  await page.goto(`${APP}/fulfillment`);
  await page.waitForURL(`${APP}/login`);
  step('signed-out visitors are sent to the login page');

  await page.getByLabel('Secret API key').fill('sk_wrong_key');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('alert').getByText(/not recognised/).waitFor();
  step('a wrong key is refused');

  await page.getByLabel('Secret API key').fill(SECRET_KEY);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${APP}/fulfillment`);
  const cookie = (await context.cookies()).find((c) => c.name === 'jb_session')!;
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Lax');
  assert.ok(!cookie.value.includes(SECRET_KEY), 'the key is not kept in the browser');
  step('the secret key signs in and becomes an HTTP-only session cookie');

  // ── Orders ──
  await page.getByRole('heading', { name: 'Orders', level: 1 }).waitFor();
  const rows = page.locator('tbody tr');
  assert.equal(await rows.count(), 2);
  const held = rows.nth(0);
  const ready = rows.nth(1);
  assert.match(await ready.innerText(), /JB-261113-000001[\s\S]*Classic Solitaire[\s\S]*14K White Gold, size 6\.5[\s\S]*1\.50 ct Oval, Lab-Grown, G VS1[\s\S]*Forever[\s\S]*\$2,600\.99[\s\S]*Ready to send/);
  assert.match(await held.innerText(), /On hold[\s\S]*Paid 10\.00 but the bundle was quoted at 4000\.00[\s\S]*Resolve the hold first/);
  assert.equal(await held.getByRole('button').count(), 0, 'no fulfil button on a held order');
  assert.doesNotMatch(await page.locator('body').innerText(), /800\.00|\$400/, 'no cost data on the page');
  await shot('orders');
  step('order history lists both rings; the held one explains why and has no button');

  await ready.getByRole('button', { name: /Fulfill casting for JB-261113-000001/ }).click();
  await ready.getByText('In production').waitFor();
  assert.match(await ready.innerText(), /Cad Prep at Platform Foundry/);
  assert.equal(await ready.getByRole('button').count(), 0);
  const sent = await db.castingOrder.findFirstOrThrow({ where: { jobBagNumber: 'JB-261113-000001' }, include: { vendor: true, routeSteps: { orderBy: { sequence: 'asc' } } } });
  assert.equal(sent.status, 'IN_PRODUCTION');
  assert.equal(sent.vendor?.name, 'Platform Foundry');
  assert.deepEqual(sent.routeSteps.map((s) => s.status), ['IN_PROGRESS', 'PENDING', 'PENDING', 'PENDING']);
  step('"Fulfill Casting via Platform Foundry" moves the job into production');

  // ── Markup ──
  await page.getByRole('link', { name: 'Markup' }).click();
  await page.getByText('No markup has been saved yet').waitFor();
  assert.equal(await page.locator('.matrix tbody tr').count(), 3);
  await page.getByLabel('Natural markup percent, tier 1').fill('45');
  await page.getByText('$1,000 cost sells for $1,450').waitFor();
  await page.getByLabel('Lab-grown flat amount, tier 2').fill('75');
  await page.getByRole('button', { name: 'Add a carat tier' }).click();
  assert.equal(await page.locator('.matrix tbody tr').count(), 4);
  await page.getByLabel('Upper carat limit of tier 3').fill('1.5'); // below tier 2's limit of 2
  await page.getByRole('alert').getByText(/smallest to largest/).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Save markup' }).isDisabled());
  await page.getByLabel('Upper carat limit of tier 3').fill('3');
  await page.getByLabel('Round diamond prices').selectOption('NEAREST_10');
  await page.getByLabel('Markup on ring settings (%)').fill('120');
  await shot('markup');
  await page.getByRole('button', { name: 'Save markup' }).click();
  await page.getByText('Saved. New prices appear on your store within a minute.').waitFor();
  step('markup tiers can be edited, validated and saved');

  await page.reload();
  assert.equal(await page.getByText('No markup has been saved yet').count(), 0);
  assert.equal(await page.getByLabel('Natural markup percent, tier 1').inputValue(), '45');
  assert.equal(await page.getByLabel('Lab-grown flat amount, tier 2').inputValue(), '75');
  assert.equal(await page.getByLabel('Upper carat limit of tier 3').inputValue(), '3');
  assert.equal(await page.locator('.matrix tbody tr').count(), 4);
  assert.equal(await page.getByLabel('Markup on ring settings (%)').inputValue(), '120');
  const saved = await db.markupRule.findMany({ where: { tenantId: tenant.id } });
  assert.equal(saved.length, 9); // 4 tiers × 2 origins + settings
  const top = saved.find((r) => r.origin === 'NATURAL' && r.caratMin?.toNumber() === 3)!;
  assert.deepEqual([top.caratMax, top.rounding, top.markupPercent.toNumber()], [null, 'NEAREST_10', 30]);
  step('saved markup survives a reload and is stored as pricing rules');

  // ── Billing ──
  await page.getByRole('link', { name: 'Billing' }).click();
  await page.getByText('Trial', { exact: true }).waitFor();
  assert.match(await page.locator('main').innerText(), /\$99\.00 per month[\s\S]*Trial ends[\s\S]*December 1, 2026[\s\S]*Stripe/);
  await shot('billing');
  await page.getByRole('button', { name: 'Subscribe for $99.00 a month' }).click();
  await page.locator('#stripe-checkout').waitFor();
  const checkout = stripeCalls.find((c) => c.path === '/v1/checkout/sessions')!;
  assert.equal(checkout.body.mode, 'subscription');
  assert.equal(checkout.body.client_reference_id, tenant.id);
  assert.equal(checkout.body['line_items[0][price]'], 'price_e2e');
  step('Subscribe sends the merchant to Stripe Checkout for this tenant');

  // Stripe confirms the payment by webhook
  const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_e2e', customer: 'cus_e2e', client_reference_id: tenant.id } } });
  const at = Math.floor(Date.now() / 1000);
  const signature = `t=${at},v1=${createHmac('sha256', WHSEC).update(`${at}.${event}`).digest('hex')}`;
  const forged = await fetch(`${APP}/api/billing/stripe/webhook`, { method: 'POST', body: event, headers: { 'stripe-signature': signature.replace(/.$/, '0') === signature ? `${signature}1` : signature.replace(/.$/, '0') } });
  assert.equal(forged.status, 401);
  assert.equal((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).subscriptionStatus, 'TRIALING');
  const delivered = await fetch(`${APP}/api/billing/stripe/webhook`, { method: 'POST', body: event, headers: { 'stripe-signature': signature } });
  assert.deepEqual([delivered.status, await delivered.json()], [200, { received: true, handled: true }]);

  await page.goto(`${APP}/billing?checkout=success`);
  await page.getByText('Active', { exact: true }).waitFor();
  assert.match(await page.locator('main').innerText(), /Next payment[\s\S]*December 13, 2026/);
  step('a signed Stripe webhook activates the subscription; a forged one is refused');

  await page.getByRole('button', { name: 'Manage card, invoices or cancel' }).click();
  await page.locator('#stripe-portal').waitFor();
  assert.equal(stripeCalls.find((c) => c.path === '/v1/billing_portal/sessions')!.body.customer, 'cus_e2e');
  step('an active subscriber is sent to the Stripe billing portal');

  // ── Protection ──
  const crossSite = await fetch(`${APP}/api/billing/subscribe`, { method: 'POST', redirect: 'manual', headers: { origin: 'https://evil.example', cookie: `jb_session=${cookie.value}` } });
  assert.equal(crossSite.status, 403);
  const anonymous = await fetch(`${APP}/api/billing/subscribe`, { method: 'POST', redirect: 'manual' });
  assert.equal(anonymous.status, 303);
  assert.match(anonymous.headers.get('location') ?? '', /\/login$/);
  step('billing actions refuse cross-site and signed-out requests');

  await page.goto(`${APP}/fulfillment`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(`${APP}/login`);
  await page.goto(`${APP}/markup-settings`);
  await page.waitForURL(`${APP}/login`);
  step('signing out ends the session');

  assert.deepEqual(pageErrors, [], 'no uncaught page errors');
  console.log(`${passed} passed`);
} catch (err) {
  if (shots) await page.screenshot({ path: join(shots, 'dashboard-FAILED.png'), fullPage: true }).catch(() => {});
  console.error(err);
  console.error('--- server log ---\n' + serverLog.split('\n').slice(-25).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  next.kill('SIGTERM');
  stripe.close();
  await db.$disconnect();
  // Open sockets to the stopped servers would otherwise keep the process alive.
  process.exit(process.exitCode ?? 0);
}
