/**
 * The parts of the markup matrix that both the browser form and the server
 * use. Nothing here touches the database, so it is safe in client components.
 */
import type { PriceRounding, StoneOrigin } from '@jewelry/db';

export const ORIGINS = ['NATURAL', 'LAB_GROWN'] as const satisfies readonly StoneOrigin[];
export const ROUNDINGS = ['NONE', 'NEAREST_1', 'NEAREST_10', 'NEAREST_100', 'ENDING_99'] as const satisfies readonly PriceRounding[];
export const MAX_TIERS = 12;

export interface MatrixCell {
  /** Markup percentage: 40 means the price is cost × 1.40. */
  percent: number;
  /** Flat amount added after the percentage, in USD. */
  fixed: number;
}

export interface MarkupMatrixData {
  /**
   * Upper carat bound of every tier except the last, ascending.
   * [1, 2] means three tiers: under 1 ct, 1 to under 2 ct, 2 ct and above.
   */
  breaks: number[];
  /** One row per tier. */
  rows: Record<StoneOrigin, MatrixCell>[];
  rounding: PriceRounding;
  /** Markup on ring settings; null leaves settings without a price (not for sale). */
  settingPercent: number | null;
}

export const DEFAULT_MATRIX: MarkupMatrixData = {
  breaks: [1, 2],
  rows: [
    { NATURAL: { percent: 50, fixed: 0 }, LAB_GROWN: { percent: 100, fixed: 0 } },
    { NATURAL: { percent: 40, fixed: 0 }, LAB_GROWN: { percent: 90, fixed: 0 } },
    { NATURAL: { percent: 30, fixed: 0 }, LAB_GROWN: { percent: 80, fixed: 0 } },
  ],
  rounding: 'NONE',
  settingPercent: 100,
};

/** Tier i covers [min, max): min is the previous break (or 0), max the next (or none). */
export const tierBounds = (breaks: readonly number[], i: number): { min: number | null; max: number | null } => ({
  min: i === 0 ? null : breaks[i - 1]!,
  max: i < breaks.length ? breaks[i]! : null,
});

/** What a stone costing `cost` sells for under a cell; for the on-screen example only. */
export function previewPrice(cost: number, c: MatrixCell, rounding: PriceRounding): number {
  const raw = cost * (1 + c.percent / 100) + c.fixed;
  switch (rounding) {
    case 'NEAREST_1':
      return Math.round(raw);
    case 'NEAREST_10':
      return Math.round(raw / 10) * 10;
    case 'NEAREST_100':
      return Math.round(raw / 100) * 100;
    case 'ENDING_99':
      return Math.floor(raw) + 0.99;
    default:
      return Math.round(raw * 100) / 100;
  }
}
