/**
 * Turns a paid storefront order into casting orders (job bags).
 *
 * Each order line is matched to the CheckoutSession recorded when the checkout
 * was created; the session, not the order payload, says what to make and what
 * it was quoted at. Intake is idempotent: platforms redeliver webhooks, and a
 * session can only ever produce one casting order.
 */
import { randomBytes } from 'node:crypto';
import { Prisma, type CastingStage, type CheckoutSession, type PrismaClient } from '@jewelry/db';
import type { NormalizedOrder, NormalizedOrderLine } from '@jewelry/platforms';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IntakeResult {
  created: { castingOrderId: string; jobBagNumber: string; status: string }[];
  /** Lines already turned into casting orders by an earlier delivery. */
  duplicates: number;
  /** Lines that are not ring-builder bundles. */
  ignored: number;
}

/** Crockford base32 without look-alike characters; e.g. JB-261112-7K3QX9. */
function newJobBagNumber(now = new Date()): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const suffix = [...randomBytes(6)].map((b) => alphabet[b % 32]).join('');
  const ymd = now.toISOString().slice(2, 10).replace(/-/g, '');
  return `JB-${ymd}-${suffix}`;
}

function routeFor(session: CheckoutSession): CastingStage[] {
  return [
    'CAD_PREP',
    'WAX_PRINT',
    'CASTING',
    'CLEANUP',
    ...(session.stoneSource === 'FEED' ? (['STONE_PROCUREMENT'] as const) : []),
    'STONE_SETTING',
    'POLISHING',
    ...(session.engraving ? (['ENGRAVING'] as const) : []),
    'QUALITY_CONTROL',
    'PACKAGING',
  ];
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

async function matchLines(
  db: PrismaClient,
  tenantId: string,
  order: NormalizedOrder,
): Promise<{ line: NormalizedOrderLine; session: CheckoutSession }[]> {
  const matches: { line: NormalizedOrderLine; session: CheckoutSession }[] = [];
  for (const line of order.lines) {
    if (!line.bundleId || !UUID.test(line.bundleId)) continue;
    const session = await db.checkoutSession.findFirst({ where: { id: line.bundleId, tenantId } });
    if (session) matches.push({ line, session });
  }
  // Platforms that cannot carry a hidden property are matched by the checkout
  // the order came from.
  if (matches.length === 0 && order.externalCheckoutId) {
    const session = await db.checkoutSession.findFirst({
      where: { tenantId, externalCheckoutId: order.externalCheckoutId },
    });
    const line =
      session &&
      (order.lines.find((l) => new Prisma.Decimal(l.unitPrice || 0).eq(session.total)) ?? order.lines[0]);
    if (session && line) matches.push({ line, session });
  }
  return matches;
}

export async function ingestPaidOrder(
  db: PrismaClient,
  tenantId: string,
  order: NormalizedOrder,
): Promise<IntakeResult> {
  const result: IntakeResult = { created: [], duplicates: 0, ignored: 0 };
  const matches = await matchLines(db, tenantId, order);
  result.ignored = order.lines.length - matches.length;

  for (const { line, session } of matches) {
    try {
      const created = await db.$transaction(async (tx) => {
        const already = await tx.castingOrder.findUnique({ where: { checkoutSessionId: session.id } });
        if (already) return null;

        const variant = await tx.virtualSettingVariant.findUniqueOrThrow({
          where: { id: session.settingVariantId },
          include: { setting: true },
        });

        // Anything that needs a person to look before production starts.
        const issues: string[] = [];
        const paid = new Prisma.Decimal(line.unitPrice || 0);
        if (paid.lt(session.total)) {
          issues.push(`Paid ${paid.toFixed(2)} but the bundle was quoted at ${session.total.toFixed(2)}.`);
        }
        if (order.currency && order.currency.toUpperCase() !== session.currency) {
          issues.push(`Paid in ${order.currency}; quoted in ${session.currency}.`);
        }
        if (line.quantity !== 1) issues.push(`Ordered quantity ${line.quantity}; a bundle is a single ring.`);

        let stoneCost = new Prisma.Decimal(0);
        let snapshot: Prisma.InputJsonValue;
        let centerDiamondId: string | null = null;
        let centerMerchantStockId: string | null = null;

        if (session.stoneSource === 'FEED') {
          const d = await tx.diamondCache.findUnique({ where: { id: session.stoneId } });
          if (!d) throw new Error(`feed diamond ${session.stoneId} no longer exists`);
          centerDiamondId = d.id;
          stoneCost = d.wholesalePrice;
          if (d.availability !== 'AVAILABLE') issues.push(`Diamond was ${d.availability} when the order arrived.`);
          const taken = await tx.castingOrder.count({
            where: { centerDiamondId: d.id, status: { not: 'CANCELED' } },
          });
          if (taken > 0) issues.push('This diamond is already allocated to another order.');
          await tx.diamondCache.update({ where: { id: d.id }, data: { availability: 'ON_HOLD' } });
          const { raw: _raw, ...attributes } = d;
          snapshot = JSON.parse(JSON.stringify({ inventory: 'FEED', ...attributes })) as Prisma.InputJsonValue;
        } else {
          const m = await tx.customMerchantStock.findFirst({ where: { id: session.stoneId, tenantId } });
          if (!m) throw new Error(`merchant stone ${session.stoneId} no longer exists`);
          centerMerchantStockId = m.id;
          stoneCost = m.costPrice ?? stoneCost;
          if (m.quantity < 1 || m.availability !== 'AVAILABLE') {
            issues.push('Merchant stone was out of stock when the order arrived.');
          } else {
            await tx.customMerchantStock.update({
              where: { id: m.id },
              data: { quantity: { decrement: 1 }, ...(m.quantity === 1 ? { availability: 'SOLD' as const } : {}) },
            });
          }
          snapshot = JSON.parse(JSON.stringify({ inventory: 'MERCHANT', ...m })) as Prisma.InputJsonValue;
        }

        const stages = routeFor(session);
        const castingOrder = await tx.castingOrder.create({
          data: {
            tenantId,
            jobBagNumber: newJobBagNumber(),
            status: issues.length ? 'ON_HOLD' : 'CONFIRMED',
            currentStage: stages[0],
            externalOrderId: order.externalOrderId,
            externalLineItemId: line.externalLineItemId || session.id,
            customerReference: order.customerReference,
            settingVariantId: variant.id,
            metal: variant.metal,
            cadId: variant.setting.cadId,
            ringSize: session.ringSize,
            engraving: session.engraving,
            notes: issues.length ? issues.join(' ') : null,
            centerDiamondId,
            centerMerchantStockId,
            centerStoneSnapshot: snapshot,
            castingCost: variant.castingCost,
            stoneCost,
            retailTotal: session.total,
            currency: session.currency,
            markupRuleId: session.stoneMarkupRuleId,
            checkoutSessionId: session.id,
            routeSteps: { create: stages.map((stage, i) => ({ sequence: i + 1, stage })) },
          },
        });
        await tx.checkoutSession.update({ where: { id: session.id }, data: { status: 'ORDERED' } });
        return castingOrder;
      });

      if (created) {
        result.created.push({
          castingOrderId: created.id,
          jobBagNumber: created.jobBagNumber,
          status: created.status,
        });
      } else {
        result.duplicates++;
      }
    } catch (err) {
      // Two deliveries of the same webhook raced; the other one won.
      if (isUniqueViolation(err)) result.duplicates++;
      else throw err;
    }
  }
  return result;
}
