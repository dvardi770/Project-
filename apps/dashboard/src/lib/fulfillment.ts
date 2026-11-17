/**
 * Order history and the hand-off of a paid ring to the platform's foundry.
 */
import type { CastingOrderStatus, CastingStage, PrismaClient } from '@jewelry/db';

export interface OrderRow {
  id: string;
  jobBagNumber: string;
  createdAt: Date;
  status: CastingOrderStatus;
  currentStage: CastingStage | null;
  externalOrderId: string;
  settingName: string;
  metal: string;
  stone: string;
  ringSize: string;
  engraving: string | null;
  total: string;
  currency: string;
  notes: string | null;
  vendorName: string | null;
  /** Finished steps out of all steps on the job bag's route. */
  progress: { done: number; total: number };
}

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

export const metalLabel = (metal: string) => {
  const karat = metal.match(/^(.*)_(\d+K)$/);
  return karat ? `${karat[2]} ${titleCase(karat[1]!)}` : titleCase(metal);
};

export const stageLabel = (stage: string) => titleCase(stage);

/** "1.50 ct Oval, Lab-Grown, G VS1" from the stone attributes snapshotted on the order. */
function describeStone(snapshot: unknown): string {
  const s = (snapshot ?? {}) as Record<string, unknown>;
  const carat = Number(s.carat);
  const parts = [
    Number.isFinite(carat) && carat > 0 ? `${carat.toFixed(2)} ct` : null,
    typeof s.shape === 'string' ? titleCase(s.shape) : null,
  ].filter(Boolean);
  const grades = [s.color, s.clarity].filter((g): g is string => typeof g === 'string').join(' ');
  return [parts.join(' ') || 'Centre stone', s.origin === 'LAB_GROWN' ? 'Lab-Grown' : s.origin === 'NATURAL' ? 'Natural' : null, grades || null]
    .filter(Boolean)
    .join(', ');
}

export async function listOrders(db: PrismaClient, tenantId: string, limit = 100): Promise<OrderRow[]> {
  const orders = await db.castingOrder.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      settingVariant: { select: { setting: { select: { name: true } } } },
      vendor: { select: { name: true } },
      routeSteps: { select: { status: true } },
    },
  });
  return orders.map((o) => ({
    id: o.id,
    jobBagNumber: o.jobBagNumber,
    createdAt: o.createdAt,
    status: o.status,
    currentStage: o.currentStage,
    externalOrderId: o.externalOrderId,
    settingName: o.settingVariant.setting.name,
    metal: metalLabel(o.metal),
    stone: describeStone(o.centerStoneSnapshot),
    ringSize: o.ringSize.toString(),
    engraving: o.engraving,
    total: o.retailTotal.toFixed(2),
    currency: o.currency,
    notes: o.notes,
    vendorName: o.vendor?.name ?? null,
    progress: {
      done: o.routeSteps.filter((s) => s.status === 'COMPLETED' || s.status === 'SKIPPED').length,
      total: o.routeSteps.length,
    },
  }));
}

export type FulfillResult = { ok: true; jobBagNumber: string; vendorName: string } | { ok: false; message: string };

/**
 * "Fulfill Casting via Platform Foundry": release a confirmed order into
 * production at the platform's foundry.
 *
 * The order moves CONFIRMED → IN_PRODUCTION, is assigned to the foundry, and
 * the first stop on its route starts. Only a CONFIRMED order can be released:
 * the status is checked in the same statement that changes it, so a double
 * click, or two people clicking at once, releases it exactly once. Orders that
 * are ON_HOLD (underpaid, or the stone was no longer available) need a person
 * to resolve the note on them first.
 */
export async function fulfillViaFoundry(db: PrismaClient, tenantId: string, orderId: string, foundryName: string): Promise<FulfillResult> {
  return db.$transaction(async (tx) => {
    const order = await tx.castingOrder.findFirst({ where: { id: orderId, tenantId } });
    if (!order) return { ok: false, message: 'Order not found.' };
    if (order.status !== 'CONFIRMED') {
      return {
        ok: false,
        message:
          order.status === 'ON_HOLD'
            ? `${order.jobBagNumber} is on hold and cannot be sent yet. ${order.notes ?? ''}`.trim()
            : `${order.jobBagNumber} has already been sent to production.`,
      };
    }

    const vendor =
      (await tx.castingVendor.findUnique({ where: { name: foundryName } })) ??
      (await tx.castingVendor.create({ data: { name: foundryName } }));
    if (!vendor.isActive) return { ok: false, message: `${vendor.name} is not accepting orders at the moment.` };

    const now = new Date();
    const first = await tx.castingRouteStep.findFirst({ where: { orderId: order.id }, orderBy: { sequence: 'asc' } });
    const released = await tx.castingOrder.updateMany({
      where: { id: order.id, tenantId, status: 'CONFIRMED' },
      data: { status: 'IN_PRODUCTION', vendorId: vendor.id, currentStage: first?.stage ?? order.currentStage },
    });
    if (released.count === 0) return { ok: false, message: `${order.jobBagNumber} has already been sent to production.` };

    if (first && first.status === 'PENDING') {
      await tx.castingRouteStep.update({
        where: { id: first.id },
        data: { status: 'IN_PROGRESS', startedAt: now, vendorId: vendor.id },
      });
    }
    return { ok: true, jobBagNumber: order.jobBagNumber, vendorName: vendor.name };
  });
}
