/**
 * Resolves a setting variant + centre stone into a validated, priced bundle.
 * Used when a bundle is quoted (POST /bundle) and again when it is checked out,
 * so availability and compatibility are re-verified at both points.
 */
import { Prisma, type VirtualSetting, type VirtualSettingVariant } from '@jewelry/db';
import { calculateRetailPrice } from '@jewelry/pricing';
import type { AppDeps } from '../common/context';
import { conflict, notFound, unprocessable } from '../common/errors';
import { loadStone, type Stone, type StoneSource } from '../common/stones';
import type { TenantContext } from '../common/tenantAuth';

export interface BundleInput {
  settingVariantId: string;
  stoneSource: StoneSource;
  stoneId: string;
  ringSize: Prisma.Decimal.Value;
  engraving?: string | null;
}

export interface ResolvedBundle {
  variant: VirtualSettingVariant;
  setting: VirtualSetting;
  stone: Stone;
  ringSize: Prisma.Decimal;
  engraving: string | null;
  settingPrice: Prisma.Decimal;
  stonePrice: Prisma.Decimal;
  stoneRuleId: string | null;
  total: Prisma.Decimal;
  currency: string;
  /** Display strings shared by the cart line and the platform checkout. */
  title: string;
  sku: string;
  imageUrl: string | null;
  metalLabel: string;
  stoneDescription: string;
  certificate: string | null;
  /** Shopper-visible line-item properties. */
  properties: Record<string, string>;
}

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** WHITE_GOLD_14K → "14K White Gold", PLATINUM_950 → "Platinum 950". */
export function metalLabel(metal: string): string {
  const karat = metal.match(/^(.*)_(\d+K)$/);
  return karat ? `${karat[2]} ${titleCase(karat[1]!)}` : titleCase(metal);
}

export async function resolveBundle(
  deps: AppDeps,
  tenant: Pick<TenantContext, 'tenantId' | 'feedSources'>,
  input: BundleInput,
): Promise<ResolvedBundle> {
  const { tenantId } = tenant;
  const matrix = await deps.markupMatrix(tenantId);

  const [variant, stone] = await Promise.all([
    deps.db.virtualSettingVariant.findFirst({
      where: {
        id: input.settingVariantId,
        isActive: true,
        setting: { isActive: true, OR: [{ tenantId }, { tenantId: null }] },
      },
      include: { setting: true },
    }),
    loadStone(deps.db, tenant, input.stoneSource, input.stoneId, matrix.rules),
  ]);

  // An item that no markup rule prices is not for sale; it must look exactly
  // like an item that does not exist.
  const settingPriced =
    variant &&
    calculateRetailPrice(
      { wholesalePrice: variant.castingCost, currency: variant.currency, target: 'SETTING' },
      matrix.rules,
    );
  if (!variant || !settingPriced) throw notFound('setting_not_found', 'Setting variant not found.');
  if (!stone || !stone.price) throw notFound('diamond_not_found', 'Diamond not found.');
  if (!stone.available) throw conflict('diamond_unavailable', 'This diamond is no longer available.');

  const { setting } = variant;
  if (!setting.compatibleShapes.includes(stone.shape)) {
    throw unprocessable('incompatible_shape', `This setting does not accept ${titleCase(stone.shape)} stones.`, {
      compatibleShapes: setting.compatibleShapes,
    });
  }
  if (stone.carat.lt(setting.centerCaratMin) || stone.carat.gt(setting.centerCaratMax)) {
    throw unprocessable('incompatible_carat', 'This diamond is outside the carat range of the setting.', {
      min: setting.centerCaratMin.toNumber(),
      max: setting.centerCaratMax.toNumber(),
    });
  }
  const ringSize = new Prisma.Decimal(input.ringSize);
  if (
    (setting.minRingSize && ringSize.lt(setting.minRingSize)) ||
    (setting.maxRingSize && ringSize.gt(setting.maxRingSize))
  ) {
    throw unprocessable('ring_size_unavailable', 'This setting is not made in that ring size.', {
      min: setting.minRingSize?.toNumber() ?? null,
      max: setting.maxRingSize?.toNumber() ?? null,
    });
  }
  if (settingPriced.currency !== stone.price.currency) {
    throw unprocessable('currency_mismatch', 'Setting and diamond are priced in different currencies.');
  }

  const engraving = input.engraving?.trim() || null;
  const metal = metalLabel(variant.metal);
  const grades = [stone.color, stone.clarity, stone.cut ? titleCase(stone.cut) : null].filter(Boolean);
  const stoneDescription = [
    `${stone.carat.toFixed(2)}ct`,
    titleCase(stone.shape),
    stone.origin === 'LAB_GROWN' ? 'Lab-Grown' : 'Natural',
    ...grades,
  ].join(' ');
  const certificate =
    stone.lab !== 'NONE' && stone.certificateNumber ? `${stone.lab} ${stone.certificateNumber}` : null;

  return {
    variant,
    setting,
    stone,
    ringSize,
    engraving,
    settingPrice: settingPriced.retailPrice,
    stonePrice: stone.price.retailPrice,
    stoneRuleId: stone.price.ruleId,
    total: settingPriced.retailPrice.plus(stone.price.retailPrice),
    currency: settingPriced.currency,
    title: `${setting.name} in ${metal} with ${stone.carat.toFixed(2)}ct ${titleCase(stone.shape)} Diamond`,
    sku: `${setting.sku}-${variant.metal}`,
    imageUrl: variant.imageUrls[0] ?? setting.thumbnailUrl ?? stone.imageUrl,
    metalLabel: metal,
    stoneDescription,
    certificate,
    properties: {
      Setting: setting.name,
      Metal: metal,
      'Ring size': ringSize.toString(),
      Diamond: stoneDescription,
      ...(certificate ? { Certificate: certificate } : {}),
      ...(engraving ? { Engraving: engraving } : {}),
    },
  };
}
