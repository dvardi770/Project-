import type {
  Availability,
  CutGrade,
  DiamondClarity,
  DiamondColor,
  DiamondShape,
  Fluorescence,
  FeedSource,
  GradingLab,
  Prisma,
  StoneOrigin,
} from '@jewelry/db';

/**
 * A wholesale diamond in the platform's own vocabulary. Field-for-field this
 * is the writable part of the DiamondCache model, so every feed adapter
 * produces the same thing and one writer persists it.
 */
export interface NormalizedDiamond {
  source: FeedSource;
  sourceStockId: string;
  supplierName: string | null;

  lab: GradingLab;
  certificateNumber: string | null;
  certificateUrl: string | null;

  origin: StoneOrigin;
  shape: DiamondShape;
  carat: Prisma.Decimal;
  color: DiamondColor | null;
  clarity: DiamondClarity | null;
  cut: CutGrade | null;
  polish: CutGrade | null;
  symmetry: CutGrade | null;
  fluorescence: Fluorescence | null;

  fancyColor: string | null;
  fancyIntensity: string | null;
  fancyOvertone: string | null;

  lengthMm: Prisma.Decimal | null;
  widthMm: Prisma.Decimal | null;
  depthMm: Prisma.Decimal | null;
  lwRatio: Prisma.Decimal | null;
  depthPercent: Prisma.Decimal | null;
  tablePercent: Prisma.Decimal | null;
  girdle: string | null;
  culet: string | null;

  wholesalePrice: Prisma.Decimal;
  pricePerCarat: Prisma.Decimal;
  currency: string;
  rapDiscountPct: Prisma.Decimal | null;

  imageUrl: string | null;
  videoUrl: string | null;
  locationCountry: string | null;
  deliveryDays: number | null;
  availability: Availability;

  /** Untouched upstream record, kept for re-normalisation. */
  raw: Prisma.InputJsonValue;
}

/** A feed record that could not be turned into a sellable diamond. */
export interface RejectedRecord {
  reason: string;
  record: unknown;
}
