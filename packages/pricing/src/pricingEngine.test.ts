import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@jewelry/db';
import {
  applyRounding,
  calculateRetailPrice,
  getRetailPrice,
  selectMarkupRule,
  type MarkupRuleInput,
} from './pricingEngine';

const D = (v: string | number) => new Prisma.Decimal(v);
let seq = 0;

function rule(overrides: Partial<MarkupRuleInput> = {}): MarkupRuleInput {
  seq++;
  return {
    id: `rule-${seq}`,
    name: `Rule ${seq}`,
    isActive: true,
    priority: 0,
    target: 'FEED_DIAMOND',
    feedSource: null,
    origin: null,
    caratMin: null,
    caratMax: null,
    costMin: null,
    costMax: null,
    markupPercent: D(0),
    fixedAddition: D(0),
    currency: 'USD',
    rounding: 'NONE',
    createdAt: new Date(2026, 0, seq),
    ...overrides,
  };
}

describe('calculateRetailPrice', () => {
  it('applies wholesale × (1 + pct/100) + fixed addition', () => {
    const result = calculateRetailPrice({ wholesalePrice: '1000.00' }, [
      rule({ markupPercent: D(35), fixedAddition: D(150) }),
    ]);
    expect(result?.retailPrice.toFixed(2)).toBe('1500.00');
    expect(result?.markupAmount.toFixed(2)).toBe('500.00');
  });

  it('does decimal, not floating-point, arithmetic', () => {
    const result = calculateRetailPrice({ wholesalePrice: '1234.56' }, [rule({ markupPercent: D('17.5') })]);
    expect(result?.retailPrice.toFixed(2)).toBe('1450.61'); // 1450.608
  });

  it('picks the matrix cell by carat range (half-open) and origin', () => {
    const matrix = [
      rule({ name: 'nat <1ct', origin: 'NATURAL', caratMax: D(1), markupPercent: D(50) }),
      rule({ name: 'nat 1-2ct', origin: 'NATURAL', caratMin: D(1), caratMax: D(2), markupPercent: D(40) }),
      rule({ name: 'nat 2ct+', origin: 'NATURAL', caratMin: D(2), markupPercent: D(30) }),
      rule({ name: 'lab any', origin: 'LAB_GROWN', markupPercent: D(100), fixedAddition: D(200) }),
    ];
    const price = (carat: string, origin: 'NATURAL' | 'LAB_GROWN') =>
      calculateRetailPrice({ wholesalePrice: 1000, carat, origin }, matrix);

    expect(price('0.99', 'NATURAL')?.rule.name).toBe('nat <1ct');
    expect(price('1.00', 'NATURAL')?.rule.name).toBe('nat 1-2ct');
    expect(price('2.00', 'NATURAL')?.rule.name).toBe('nat 2ct+');
    expect(price('1.50', 'LAB_GROWN')?.retailPrice.toFixed(2)).toBe('2200.00');
  });

  it('returns null when nothing matches', () => {
    const rules = [rule({ origin: 'NATURAL' }), rule({ isActive: false })];
    expect(calculateRetailPrice({ wholesalePrice: 500, origin: 'LAB_GROWN' }, rules)).toBeNull();
    expect(calculateRetailPrice({ wholesalePrice: 500 }, [])).toBeNull();
  });

  it('ignores rules for another target or currency', () => {
    const rules = [rule({ target: 'SETTING' }), rule({ currency: 'EUR' })];
    expect(calculateRetailPrice({ wholesalePrice: 500 }, rules)).toBeNull();
  });

  it('does not match a carat-bounded rule when the item has no carat', () => {
    expect(calculateRetailPrice({ wholesalePrice: 500 }, [rule({ caratMin: D(1) })])).toBeNull();
  });

  it('rejects non-positive wholesale prices', () => {
    expect(() => calculateRetailPrice({ wholesalePrice: 0 }, [rule()])).toThrow(RangeError);
  });
});

describe('selectMarkupRule', () => {
  it('prefers priority, then specificity, then age', () => {
    const generic = rule({ name: 'generic' });
    const specific = rule({ name: 'specific', origin: 'NATURAL', caratMin: D(1) });
    const urgent = rule({ name: 'urgent', priority: 10 });
    const item = { wholesalePrice: 100, carat: 1.2, origin: 'NATURAL' as const };

    expect(selectMarkupRule(item, [generic, specific])?.name).toBe('specific');
    expect(selectMarkupRule(item, [generic, specific, urgent])?.name).toBe('urgent');
    const older = rule({ name: 'older', createdAt: new Date(2020, 0, 1) });
    expect(selectMarkupRule(item, [generic, older])?.name).toBe('older');
  });

  it('matches on wholesale cost bands and feed source', () => {
    const rules = [
      rule({ name: 'cheap', costMax: D(1000), markupPercent: D(60) }),
      rule({ name: 'dear', costMin: D(1000), markupPercent: D(25) }),
      rule({ name: 'rapnet', feedSource: 'RAPNET', priority: 5 }),
    ];
    expect(selectMarkupRule({ wholesalePrice: 999.99 }, rules)?.name).toBe('cheap');
    expect(selectMarkupRule({ wholesalePrice: 1000 }, rules)?.name).toBe('dear');
    expect(selectMarkupRule({ wholesalePrice: 1000, feedSource: 'RAPNET' }, rules)?.name).toBe('rapnet');
  });
});

describe('applyRounding', () => {
  it.each([
    ['NONE', '1234.565', '1234.57'],
    ['NEAREST_1', '1234.50', '1235.00'],
    ['NEAREST_10', '1234.99', '1230.00'],
    ['NEAREST_100', '1250.00', '1300.00'],
    ['ENDING_99', '1234.00', '1234.99'],
    ['ENDING_99', '1234.50', '1234.99'],
  ] as const)('%s: %s → %s', (mode, input, expected) => {
    expect(applyRounding(D(input), mode).toFixed(2)).toBe(expected);
  });
});

describe('getRetailPrice', () => {
  it("queries the tenant's active rules for the item's target", async () => {
    const findMany = vi.fn().mockResolvedValue([rule({ markupPercent: D(20), rounding: 'NEAREST_10' })]);
    const db = { markupRule: { findMany } } as never;

    const result = await getRetailPrice(db, 'tenant-1', { wholesalePrice: 2012 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-1', isActive: true, target: 'FEED_DIAMOND' } }),
    );
    expect(result?.retailPrice.toFixed(2)).toBe('2410.00'); // 2414.40 → nearest 10
  });
});
