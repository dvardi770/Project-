/**
 * The markup matrix the dashboard edits: carat tiers down the side, stone
 * origin across the top, a percentage (and optional flat amount) in each cell.
 *
 * Underneath, each cell is one MarkupRule. Only "simple" rules are managed
 * here: rules for feed diamonds that match on origin and carat range alone.
 * Rules with other criteria (a feed, a cost band, a priority) are left exactly
 * as they are, so anything set up by hand survives a save.
 */
import { Prisma, type MarkupRule, type PrismaClient, type StoneOrigin } from '@jewelry/db';
import { z } from 'zod';

import {
  DEFAULT_MATRIX,
  MAX_TIERS,
  ORIGINS,
  ROUNDINGS,
  tierBounds,
  type MarkupMatrixData,
  type MatrixCell,
} from './markup-shared';

export * from './markup-shared';

const cell = z.object({
  percent: z.number().min(0, 'Markup cannot be negative').max(1000, 'Markup cannot exceed 1000%'),
  fixed: z.number().min(0, 'Flat amount cannot be negative').max(1_000_000),
});

export const matrixSchema = z
  .object({
    breaks: z.array(z.number().positive().max(100)).max(MAX_TIERS - 1),
    rows: z.array(z.object({ NATURAL: cell, LAB_GROWN: cell })).min(1).max(MAX_TIERS),
    rounding: z.enum(ROUNDINGS),
    settingPercent: z.number().min(0).max(1000).nullable(),
  })
  .superRefine((m, ctx) => {
    if (m.rows.length !== m.breaks.length + 1) {
      ctx.addIssue({ code: 'custom', message: 'Each carat tier needs a row.' });
    }
    for (let i = 1; i < m.breaks.length; i++) {
      if (m.breaks[i]! <= m.breaks[i - 1]!) {
        ctx.addIssue({ code: 'custom', message: 'Carat tiers must go from smallest to largest, with no repeats.' });
        break;
      }
    }
  });

type SimpleRule = Pick<
  MarkupRule,
  'target' | 'isActive' | 'priority' | 'feedSource' | 'origin' | 'caratMin' | 'caratMax' | 'costMin' | 'costMax'
>;

/** A diamond rule this page owns: origin + carat range and nothing else. */
export const isMatrixRule = (r: SimpleRule) =>
  r.target === 'FEED_DIAMOND' && r.origin !== null && r.feedSource === null && r.costMin === null && r.costMax === null && r.priority === 0;

/** The single catch-all rule for settings. */
export const isSettingRule = (r: SimpleRule) =>
  r.target === 'SETTING' && r.origin === null && r.feedSource === null && r.caratMin === null && r.caratMax === null && r.costMin === null && r.costMax === null && r.priority === 0;

export interface LoadedMatrix {
  matrix: MarkupMatrixData;
  /** False when nothing has been saved yet and the defaults are being shown. */
  saved: boolean;
  /** Active rules this page does not manage; they can still win over the matrix. */
  otherRules: number;
}

/** Rebuild the matrix from stored rules. */
export function rulesToMatrix(rules: readonly MarkupRule[]): LoadedMatrix {
  const active = rules.filter((r) => r.isActive);
  const mine = active.filter(isMatrixRule);
  const setting = active.find(isSettingRule);
  const otherRules = active.filter((r) => !isMatrixRule(r) && !isSettingRule(r)).length;
  if (mine.length === 0) {
    return {
      matrix: { ...DEFAULT_MATRIX, settingPercent: setting ? setting.markupPercent.toNumber() : DEFAULT_MATRIX.settingPercent },
      saved: false,
      otherRules,
    };
  }

  // Every boundary used by either origin becomes a tier edge.
  const edges = new Set<number>();
  for (const r of mine) {
    if (r.caratMin) edges.add(r.caratMin.toNumber());
    if (r.caratMax) edges.add(r.caratMax.toNumber());
  }
  const breaks = [...edges].filter((e) => e > 0).sort((a, b) => a - b).slice(0, MAX_TIERS - 1);

  const covering = (origin: StoneOrigin, at: number): MatrixCell => {
    const rule = mine.find(
      (r) => r.origin === origin && (r.caratMin === null || r.caratMin.toNumber() <= at) && (r.caratMax === null || r.caratMax.toNumber() > at),
    );
    return rule ? { percent: rule.markupPercent.toNumber(), fixed: rule.fixedAddition.toNumber() } : { percent: 0, fixed: 0 };
  };
  const rows = Array.from({ length: breaks.length + 1 }, (_, i) => {
    const at = tierBounds(breaks, i).min ?? 0;
    return { NATURAL: covering('NATURAL', at), LAB_GROWN: covering('LAB_GROWN', at) };
  });

  return {
    matrix: { breaks, rows, rounding: mine[0]!.rounding, settingPercent: setting ? setting.markupPercent.toNumber() : null },
    saved: true,
    otherRules,
  };
}

const label = (origin: StoneOrigin) => (origin === 'NATURAL' ? 'Natural' : 'Lab-grown');
const tierName = (min: number | null, max: number | null) =>
  min === null ? `under ${max} ct` : max === null ? `${min} ct and above` : `${min} to ${max} ct`;

/**
 * Replace the tenant's matrix rules with `matrix`, in one transaction.
 * Rules whose origin and carat range are unchanged are updated in place, so
 * past orders keep pointing at the rule that priced them.
 */
export async function saveMatrix(db: PrismaClient, tenantId: string, input: unknown): Promise<MarkupMatrixData> {
  const matrix = matrixSchema.parse(input);
  const single = matrix.rows.length === 1;

  await db.$transaction(async (tx) => {
    const existing = await tx.markupRule.findMany({ where: { tenantId } });
    const mine = existing.filter(isMatrixRule);
    const keep = new Set<string>();
    const key = (origin: StoneOrigin, min: number | null, max: number | null) => `${origin}|${min ?? ''}|${max ?? ''}`;
    const byKey = new Map(
      mine.map((r) => [key(r.origin!, r.caratMin?.toNumber() ?? null, r.caratMax?.toNumber() ?? null), r]),
    );

    for (let i = 0; i < matrix.rows.length; i++) {
      const { min, max } = tierBounds(matrix.breaks, i);
      for (const origin of ORIGINS) {
        const c = matrix.rows[i]![origin];
        const data = {
          name: single ? `${label(origin)} diamonds` : `${label(origin)}, ${tierName(min, max)}`,
          isActive: true,
          markupPercent: new Prisma.Decimal(c.percent),
          fixedAddition: new Prisma.Decimal(c.fixed),
          rounding: matrix.rounding,
        };
        const match = byKey.get(key(origin, min, max));
        if (match) {
          keep.add(match.id);
          await tx.markupRule.update({ where: { id: match.id }, data });
        } else {
          await tx.markupRule.create({
            data: { ...data, tenantId, target: 'FEED_DIAMOND', origin, caratMin: min, caratMax: max, priority: 0 },
          });
        }
      }
    }
    const stale = mine.filter((r) => !keep.has(r.id)).map((r) => r.id);
    if (stale.length) await tx.markupRule.deleteMany({ where: { id: { in: stale }, tenantId } });

    const setting = existing.find(isSettingRule);
    if (matrix.settingPercent === null) {
      if (setting) await tx.markupRule.delete({ where: { id: setting.id } });
    } else {
      const data = { name: 'Ring settings', isActive: true, markupPercent: new Prisma.Decimal(matrix.settingPercent) };
      if (setting) await tx.markupRule.update({ where: { id: setting.id }, data });
      else await tx.markupRule.create({ data: { ...data, tenantId, target: 'SETTING', priority: 0 } });
    }
  });
  return matrix;
}
