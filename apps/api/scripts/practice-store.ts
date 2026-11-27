/**
 * Practice mode: a store with sample ring designs, sample diamonds and a starting markup, so a
 * jeweller can try the whole ring builder on their own website before offering it to anyone.
 *
 *   pnpm --filter @jewelry/api practice https://my-shop.com            set up (or refresh) the practice store
 *   pnpm --filter @jewelry/api practice https://my-shop.com --new-keys also issue fresh keys
 *   pnpm --filter @jewelry/api practice --reset                         remove the practice store and stones
 *
 * At start-up (infra/docker/start.sh) it runs as `practice --ensure` when PRACTICE_SITE is set: it
 * creates what is missing and prints keys only the first time, so it can run on every restart.
 * There, the WooCommerce connection can come from PRACTICE_WOO_KEY, PRACTICE_WOO_SECRET,
 * PRACTICE_WOO_PRODUCT_ID and PRACTICE_WEBHOOK_SECRET (needs CREDENTIALS_ENCRYPTION_KEY).
 *
 * The sample diamonds sit in the shared diamond list, so practice mode belongs on a database of
 * its own: it refuses to run where any other store exists. Nothing here is a real stone or a real
 * price; certificates read "PRACTICE-…".
 */
import { randomBytes } from 'node:crypto';
import { prisma, Prisma, type DiamondClarity, type DiamondColor, type DiamondShape, type MetalType, type MountingStyle } from '@jewelry/db';
import { createConnector, encryptJson, encryptSecret, parseEncryptionKey } from '@jewelry/platforms';
import { hashApiKey } from '../src/common/tenantAuth';

export const PRACTICE_SLUG = 'practice';
const STOCK_PREFIX = 'practice-';

/** The ring builder's demo designs (apps/ring-lab render collection "catalog"), as stocked settings. */
const DESIGNS: {
  id: string; name: string; style: MountingStyle; cost: number; description: string;
  sideStones?: { position: string; quantity: number; totalCarat: string; sizeMm: string }[];
}[] = [
  { id: 'classic-solitaire', name: 'Classic Solitaire', style: 'SOLITAIRE', cost: 340, description: 'Four slim prongs on a plain comfort-fit band.' },
  { id: 'cathedral-solitaire', name: 'Cathedral Solitaire', style: 'CATHEDRAL', cost: 420, description: 'Shoulders that arch up to the basket, open underneath.' },
  { id: 'modern-bezel', name: 'Modern Bezel', style: 'BEZEL', cost: 380, description: 'A smooth rim of metal round the stone on a petite band.' },
  { id: 'petite-pave', name: 'Petite Pavé', style: 'PAVE', cost: 520, description: 'Six prongs and a row of small diamonds along the band.',
    sideStones: [{ position: 'band', quantity: 22, totalCarat: '0.16', sizeMm: '1.25' }] },
  { id: 'round-halo', name: 'Round Halo', style: 'HALO', cost: 640, description: 'A ring of small diamonds tight round the centre stone.',
    sideStones: [{ position: 'halo', quantity: 18, totalCarat: '0.14', sizeMm: '1.10' }] },
  { id: 'hidden-halo-pave', name: 'Hidden Halo Pavé', style: 'HIDDEN_HALO', cost: 690, description: 'Small diamonds tucked under the girdle and along the band.',
    sideStones: [{ position: 'hidden halo', quantity: 20, totalCarat: '0.12', sizeMm: '0.95' }, { position: 'band', quantity: 22, totalCarat: '0.16', sizeMm: '1.25' }] },
  { id: 'three-stone-trellis', name: 'Three Stone', style: 'THREE_STONE', cost: 760, description: 'A side stone either side of the centre, in one joined setting.',
    sideStones: [{ position: 'sides', quantity: 2, totalCarat: '0.40', sizeMm: '3.70' }] },
  { id: 'vintage-milgrain', name: 'Vintage Milgrain', style: 'VINTAGE', cost: 780, description: 'A halo and a beaded band in an heirloom style.',
    sideStones: [{ position: 'halo', quantity: 18, totalCarat: '0.14', sizeMm: '1.10' }, { position: 'band', quantity: 24, totalCarat: '0.17', sizeMm: '1.20' }] },
];
const METALS: [MetalType, number][] = [['WHITE_GOLD_14K', 1], ['YELLOW_GOLD_14K', 1], ['ROSE_GOLD_14K', 1], ['PLATINUM_950', 1.9]];
const SHAPES_FOR_SETTINGS: DiamondShape[] = ['ROUND', 'OVAL', 'CUSHION', 'PRINCESS', 'EMERALD', 'PEAR', 'RADIANT', 'ASSCHER', 'MARQUISE'];

// Markup to start from: the dashboard's default table, so it shows there and can be changed.
const MARKUP = [
  { min: null, max: 1, NATURAL: 50, LAB_GROWN: 100 },
  { min: 1, max: 2, NATURAL: 40, LAB_GROWN: 90 },
  { min: 2, max: null, NATURAL: 30, LAB_GROWN: 80 },
] as const;
const tierName = (min: number | null, max: number | null) =>
  min === null ? `under ${max} ct` : max === null ? `${min} ct and above` : `${min} to ${max} ct`;

// ── Sample diamonds: a spread of shapes, sizes and grades, priced like real wholesale ──
const SHAPE_MIX: [DiamondShape, number, number][] = [
  // shape, how many, length ÷ width
  ['ROUND', 14, 1], ['OVAL', 8, 1.38], ['CUSHION', 5, 1.05], ['PRINCESS', 4, 1], ['EMERALD', 5, 1.42],
  ['PEAR', 4, 1.55], ['RADIANT', 3, 1.25], ['MARQUISE', 2, 2], ['ASSCHER', 3, 1],
];
const CARATS = [0.5, 0.7, 0.9, 1.0, 1.01, 1.2, 1.5, 1.7, 2.0, 2.5, 3.0];
const COLORS: DiamondColor[] = ['D', 'E', 'F', 'G', 'H', 'I', 'J'];
const CLARITIES: DiamondClarity[] = ['IF', 'VVS1', 'VVS2', 'VS1', 'VS2', 'SI1', 'SI2'];
// Natural wholesale per carat at G VS2, by size (USD), and how colour and clarity move it.
const PER_CARAT = [[0.5, 2600], [0.7, 3400], [0.9, 4300], [1.0, 6200], [1.5, 8600], [2.0, 12500], [3.0, 19000]];
const COLOR_FACTOR: Record<string, number> = { D: 1.45, E: 1.3, F: 1.18, G: 1, H: 0.88, I: 0.76, J: 0.66 };
const CLARITY_FACTOR: Record<string, number> = { IF: 1.45, VVS1: 1.3, VVS2: 1.2, VS1: 1.1, VS2: 1, SI1: 0.86, SI2: 0.74 };

function perCarat(carat: number): number {
  let best = PER_CARAT[0]![1]!;
  for (const [c, p] of PER_CARAT) if (carat >= c!) best = p!;
  return best;
}

export function practiceDiamonds(): Prisma.DiamondCacheCreateInput[] {
  const out: Prisma.DiamondCacheCreateInput[] = [];
  let n = 0;
  for (const [shape, count, ratio] of SHAPE_MIX) {
    for (let k = 0; k < count; k++, n++) {
      const carat = CARATS[(n * 7 + k * 3) % CARATS.length]!;
      const color = COLORS[(n * 5 + 2) % COLORS.length]!;
      const clarity = CLARITIES[(n * 3 + 1) % CLARITIES.length]!;
      const lab = n % 3 === 2;
      const fancyDiscount = shape === 'ROUND' ? 1 : 0.78;
      const naturalPrice = carat * perCarat(carat) * COLOR_FACTOR[color]! * CLARITY_FACTOR[clarity]! * fancyDiscount;
      const wholesale = Math.round((lab ? naturalPrice * 0.12 + 120 * carat : naturalPrice) / 5) * 5;
      // Face-up size from weight: a round of 1 ct is about 6.4 mm across.
      const width = (6.4 * Math.cbrt(carat)) / Math.sqrt(ratio) * (shape === 'ROUND' ? 1 : 0.97);
      const length = width * ratio;
      out.push({
        source: 'NIVODA',
        sourceStockId: `${STOCK_PREFIX}${String(n + 1).padStart(3, '0')}`,
        supplierName: 'Practice stones',
        lab: lab ? 'IGI' : 'GIA',
        certificateNumber: `PRACTICE-${String(n + 1).padStart(4, '0')}`,
        origin: lab ? 'LAB_GROWN' : 'NATURAL',
        shape,
        carat: carat.toFixed(2),
        color,
        clarity,
        cut: shape === 'ROUND' ? (n % 2 ? 'EXCELLENT' : 'IDEAL') : null,
        polish: 'EXCELLENT',
        symmetry: n % 4 === 3 ? 'VERY_GOOD' : 'EXCELLENT',
        fluorescence: n % 5 === 4 ? 'FAINT' : 'NONE',
        lengthMm: length.toFixed(2),
        widthMm: width.toFixed(2),
        depthMm: (width * 0.62).toFixed(2),
        lwRatio: ratio.toFixed(2),
        depthPercent: shape === 'ROUND' ? '61.8' : '64.0',
        tablePercent: shape === 'ROUND' ? '57.0' : '62.0',
        wholesalePrice: wholesale.toFixed(2),
        pricePerCarat: (wholesale / carat).toFixed(2),
        locationCountry: 'US',
        deliveryDays: 3 + (n % 5),
        raw: { practice: true },
      });
    }
  }
  return out;
}

interface Options {
  site?: string;
  ensure?: boolean;
  newKeys?: boolean;
  reset?: boolean;
  woo?: { consumerKey: string; consumerSecret: string; placeholderProductId: number; webhookSecret?: string };
}

const log = (...lines: string[]) => console.log(lines.join('\n'));

/** The site's host name and its www/bare twin. */
export function siteHosts(site: string): { url: string; hosts: string[] } {
  const url = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`);
  const host = url.hostname.toLowerCase();
  const twin = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  return { url: `${url.protocol}//${url.host}`, hosts: host.includes('.') && !/^\d+(\.\d+){3}$/.test(host) ? [host, twin] : [host] };
}

export async function practice(opts: Options): Promise<void> {
  const others = await prisma.tenant.count({ where: { slug: { not: PRACTICE_SLUG } } });
  const realStones = await prisma.diamondCache.count({ where: { NOT: { sourceStockId: { startsWith: STOCK_PREFIX } } } });
  if (others > 0 || realStones > 0) {
    throw new Error(
      'This database already holds real stores or real diamonds. Practice mode adds sample diamonds that every ' +
        'store would see, so it only runs on a database of its own. Create a separate database for practising.',
    );
  }

  if (opts.reset) {
    await prisma.tenant.deleteMany({ where: { slug: PRACTICE_SLUG } });
    const { count } = await prisma.diamondCache.deleteMany({ where: { sourceStockId: { startsWith: STOCK_PREFIX } } });
    log('Practice store removed, and ' + count + ' sample diamonds.');
    return;
  }
  if (!opts.site) throw new Error('usage: practice <your website, e.g. https://my-shop.com> [--new-keys] | --reset');
  const { url, hosts } = siteHosts(opts.site);

  // The store.
  let tenant = await prisma.tenant.findUnique({ where: { slug: PRACTICE_SLUG } });
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: { name: 'Practice Store', slug: PRACTICE_SLUG, platformType: 'WOOCOMMERCE', platformStoreId: url, subscriptionStatus: 'ACTIVE' },
    });
  } else if (tenant.platformStoreId !== url) {
    tenant = await prisma.tenant.update({ where: { id: tenant.id }, data: { platformStoreId: url } });
  }
  const tenantId = tenant.id;

  // The website it may be used from.
  for (const hostname of hosts) {
    const existing = await prisma.tenantDomain.findUnique({ where: { hostname } });
    if (!existing) await prisma.tenantDomain.create({ data: { tenantId, hostname, isPrimary: hostname === hosts[0] } });
  }

  // A starting markup (only if there is none: changes made in the dashboard are kept).
  if ((await prisma.markupRule.count({ where: { tenantId } })) === 0) {
    for (const tier of MARKUP) {
      for (const origin of ['NATURAL', 'LAB_GROWN'] as const) {
        await prisma.markupRule.create({
          data: {
            tenantId, target: 'FEED_DIAMOND', origin, caratMin: tier.min, caratMax: tier.max, priority: 0,
            name: `${origin === 'NATURAL' ? 'Natural' : 'Lab-grown'}, ${tierName(tier.min, tier.max)}`,
            markupPercent: new Prisma.Decimal(tier[origin]),
          },
        });
      }
    }
    await prisma.markupRule.create({ data: { tenantId, target: 'SETTING', name: 'Ring settings', markupPercent: new Prisma.Decimal(100) } });
  }

  // Ring designs, with the rendered photos, 360° video and 3D of the "catalog" collection.
  for (const d of DESIGNS) {
    const sku = `PRACTICE-${d.id.toUpperCase()}`;
    const data = {
      name: d.name, description: d.description, style: d.style, isActive: true,
      compatibleShapes: SHAPES_FOR_SETTINGS, centerCaratMin: '0.50', centerCaratMax: '3.00',
      cadId: `practice/${d.id}`, minRingSize: '3', maxRingSize: '11', leadTimeDays: 21, bandWidthMm: '2.00',
      renderKey: `catalog/${d.id}`,
    };
    const setting = await prisma.virtualSetting.upsert({
      where: { tenantId_sku: { tenantId, sku } },
      create: { tenantId, sku, ...data },
      update: data,
    });
    for (const [metal, factor] of METALS) {
      const castingCost = (d.cost * factor).toFixed(2);
      await prisma.virtualSettingVariant.upsert({
        where: { settingId_metal: { settingId: setting.id, metal } },
        create: { settingId: setting.id, metal, castingCost },
        update: { castingCost, isActive: true },
      });
    }
    await prisma.settingSideStone.deleteMany({ where: { settingId: setting.id } });
    for (const s of d.sideStones ?? []) {
      await prisma.settingSideStone.create({ data: { settingId: setting.id, shape: 'ROUND', colorGrade: 'G-H', clarityGrade: 'VS', ...s } });
    }
  }

  // Sample diamonds (refreshed to the list above; any held or sold in practice are made available again).
  for (const stone of practiceDiamonds()) {
    const { source, sourceStockId, ...rest } = stone;
    await prisma.diamondCache.upsert({
      where: { source_sourceStockId: { source: source as 'NIVODA', sourceStockId } },
      create: stone,
      update: { ...rest, availability: 'AVAILABLE', lastSyncedAt: new Date() },
    });
  }

  // The WooCommerce connection, when given.
  if (opts.woo) {
    if (!process.env.CREDENTIALS_ENCRYPTION_KEY) throw new Error('CREDENTIALS_ENCRYPTION_KEY is not set, so the WooCommerce keys cannot be stored');
    const key = parseEncryptionKey(process.env.CREDENTIALS_ENCRYPTION_KEY);
    const credentials = { siteUrl: url, consumerKey: opts.woo.consumerKey, consumerSecret: opts.woo.consumerSecret, placeholderProductId: opts.woo.placeholderProductId };
    createConnector('WOOCOMMERCE', credentials); // checks the shape (https, product id); makes no request
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        platformCredentialsEnc: encryptJson(credentials, key),
        ...(opts.woo.webhookSecret ? { platformWebhookSecretEnc: encryptSecret(opts.woo.webhookSecret, key) } : {}),
      },
    });
  }

  // Keys: the first time (or when asked), one for the website and one for the dashboard.
  const keyCount = await prisma.apiKey.count({ where: { tenantId, revokedAt: null } });
  let printed: { publishable: string; secret: string } | null = null;
  if (keyCount === 0 || opts.newKeys) {
    const make = async (type: 'PUBLISHABLE' | 'SECRET') => {
      const key = `${type === 'SECRET' ? 'sk' : 'pk'}_live_${randomBytes(24).toString('base64url')}`;
      await prisma.apiKey.create({ data: { tenantId, type, prefix: key.slice(0, 12), keyHash: hashApiKey(key) } });
      return key;
    };
    printed = { publishable: await make('PUBLISHABLE'), secret: await make('SECRET') };
  }

  const stones = await prisma.diamondCache.count({ where: { sourceStockId: { startsWith: STOCK_PREFIX }, availability: 'AVAILABLE' } });
  log(
    '',
    `Practice store ready for ${url} (also works from ${hosts.slice(1).join(', ') || 'no other address'}).`,
    `  ${DESIGNS.length} ring designs in white, yellow and rose gold and platinum; ${stones} sample diamonds.`,
    '  Markup to start from: natural diamonds +50/40/30 %, lab-grown +100/90/80 % by size, settings +100 %.',
    `  WooCommerce: ${tenant.platformCredentialsEnc || opts.woo ? 'connected' : 'not connected yet (the builder shows; "Add to cart" needs it)'}.`,
    `  Order webhook address for WooCommerce: <this server>/webhooks/woocommerce/${tenantId}`,
  );
  if (printed) {
    log(
      '',
      'Keys (shown once, keep them somewhere safe):',
      `  For the WordPress plugin:   ${printed.publishable}`,
      `  To sign in to the dashboard: ${printed.secret}`,
    );
  } else if (!opts.ensure) {
    log('', 'Keys were issued before. Run again with --new-keys for fresh ones.');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const env = process.env;
  const ensure = args.includes('--ensure');
  const site = args.find((a) => !a.startsWith('--')) ?? (ensure ? env.PRACTICE_SITE : undefined);
  const woo = ensure && env.PRACTICE_WOO_KEY && env.PRACTICE_WOO_SECRET && env.PRACTICE_WOO_PRODUCT_ID
    ? { consumerKey: env.PRACTICE_WOO_KEY, consumerSecret: env.PRACTICE_WOO_SECRET, placeholderProductId: Number(env.PRACTICE_WOO_PRODUCT_ID), webhookSecret: env.PRACTICE_WEBHOOK_SECRET }
    : undefined;
  await practice({ site, ensure, woo, newKeys: args.includes('--new-keys'), reset: args.includes('--reset') });
}

if (process.argv[1]?.endsWith('practice-store.ts')) {
  main()
    .catch((err) => {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
