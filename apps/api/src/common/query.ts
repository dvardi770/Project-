import { z } from 'zod';

/** Accepts `?shape=ROUND,OVAL`, `?shape=ROUND&shape=OVAL`, any letter case. */
export function csvEnum<T extends Record<string, string>>(values: T) {
  return z
    .preprocess((input) => {
      if (input === undefined || input === '') return undefined;
      const parts = Array.isArray(input) ? input : [input];
      return [
        ...new Set(
          parts
            .flatMap((p) => String(p).split(','))
            .map((s) => s.trim().toUpperCase().replace(/[\s-]+/g, '_'))
            .filter(Boolean),
        ),
      ];
    }, z.array(z.enum(values)).min(1).optional());
}

export const upperEnum = <T extends Record<string, string>>(values: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toUpperCase().replace(/[\s-]+/g, '_') : v),
    z.enum(values),
  );

export const pagination = {
  page: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
};

export interface Money {
  /** Decimal string with two places, e.g. "1500.00". */
  amount: string;
  currency: string;
}
