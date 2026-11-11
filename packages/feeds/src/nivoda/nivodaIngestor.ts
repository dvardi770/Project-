/**
 * Nivoda → DiamondCache ingestion.
 *
 * Flow: authenticate (token cached ~6 h) → page through `diamonds_by_query`
 * with offset/limit → normalise each item → upsert a page per transaction →
 * once the whole feed has been read, flag stones that disappeared.
 *
 * Natural and lab-grown stones are fetched as separate slices using the
 * `labgrown` filter, so origin never depends on a response field.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type Availability, type StoneOrigin } from '@jewelry/db';
import {
  markUnseenUnavailable,
  upsertDiamonds,
  type DiamondCacheDb,
} from '../normalizer/diamondCacheWriter';
import {
  certificateLookupUrl,
  normalizeClarity,
  normalizeColor,
  normalizeCutGrade,
  normalizeFluorescence,
  normalizeLab,
  normalizeShape,
  normalizeUrl,
  parseCertificateNumber,
  toPositiveDecimal,
} from '../normalizer/grading';
import type { NormalizedDiamond, RejectedRecord } from '../normalizer/types';

export const NIVODA_PRODUCTION_URL = 'https://integrations.nivoda.net/api/diamonds';

/** Nivoda rejects page sizes above 50. */
const MAX_PAGE_SIZE = 50;
/** Tokens last 6 hours; refresh an hour early. */
const TOKEN_TTL_MS = 5 * 60 * 60 * 1000;

// ─── Configuration ───────────────────────────────────────────────────────────

export interface CaratBand {
  from: number;
  to: number;
}

export interface NivodaConfig {
  username: string;
  password: string;
  /** Defaults to the production endpoint. */
  endpoint?: string;
  /** 1–50, default 50. */
  pageSize?: number;
  /** Which inventories to pull. Default: both. */
  origins?: StoneOrigin[];
  /**
   * Split each origin into carat slices (sent as the `sizes` filter). Keeps
   * offsets shallow on very large inventories. Default: one slice per origin.
   */
  caratBands?: CaratBand[];
  /** Nivoda quotes `price` in USD cents. Set to 'dollars' if your account differs. */
  priceUnit?: 'cents' | 'dollars';
  /** Extra attempts for network errors, HTTP 429 and 5xx. Default 4. */
  maxRetries?: number;
  /** Per-request timeout. Default 30 s. */
  requestTimeoutMs?: number;
  /** Stop a slice after this many pages (smoke tests). Default: no limit. */
  maxPagesPerSlice?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injectable for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

// ─── Upstream shapes (only the fields this module reads) ─────────────────────

export interface NivodaCertificate {
  id?: string | null;
  lab?: string | null;
  shape?: string | null;
  certNumber?: string | null;
  carats?: number | string | null;
  color?: string | null;
  clarity?: string | null;
  cut?: string | null;
  polish?: string | null;
  symmetry?: string | null;
  floInt?: string | null;
  floCol?: string | null;
  length?: number | string | null;
  width?: number | string | null;
  depth?: number | string | null;
  depthPercentage?: number | string | null;
  table?: number | string | null;
  girdle?: string | null;
}

export interface NivodaDiamond {
  id: string;
  video?: string | null;
  image?: string | null;
  availability?: string | null;
  supplierStockId?: string | null;
  certificate?: NivodaCertificate | null;
}

export interface NivodaItem {
  /** Offer id — changes between sessions, so it is not used as a key. */
  id: string;
  price?: number | string | null;
  discount?: number | string | null;
  diamond?: NivodaDiamond | null;
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message: string }[];
}

interface DiamondsPage {
  as: { diamonds_by_query: { total_count: number; items: NivodaItem[] } };
}

export class NivodaApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly graphqlErrors?: { message: string }[],
  ) {
    super(message);
    this.name = 'NivodaApiError';
  }

  get isAuthError(): boolean {
    if (this.status === 401 || this.status === 403) return true;
    return (this.graphqlErrors ?? []).some((e) =>
      /unauthori[sz]ed|unauthenticated|not authenticated|token|jwt|expired/i.test(e.message),
    );
  }
}

// ─── Normalisation ───────────────────────────────────────────────────────────

const AVAILABILITY: Record<string, Availability> = {
  AVAILABLE: 'AVAILABLE',
  HOLD: 'ON_HOLD',
  ON_HOLD: 'ON_HOLD',
  MEMO: 'ON_HOLD',
  SOLD: 'SOLD',
};

function mapAvailability(raw: string | null | undefined): Availability {
  if (!raw) return 'AVAILABLE';
  return AVAILABILITY[raw.trim().toUpperCase().replace(/\s+/g, '_')] ?? 'UNAVAILABLE';
}

/**
 * Turn one `diamonds_by_query` item into a NormalizedDiamond.
 * Throws with a human-readable reason when the item cannot be sold
 * (no certificate block, no carat weight, no price).
 */
export function normalizeNivodaItem(
  item: NivodaItem,
  origin: StoneOrigin,
  priceUnit: 'cents' | 'dollars' = 'cents',
): NormalizedDiamond {
  const diamond = item.diamond;
  if (!diamond?.id) throw new Error('item has no diamond id');
  const cert = diamond.certificate;
  if (!cert) throw new Error('diamond has no certificate block');

  const carat = toPositiveDecimal(cert.carats, 3);
  if (!carat) throw new Error(`invalid carat weight: ${String(cert.carats)}`);

  const rawPrice = toPositiveDecimal(item.price, 4);
  if (!rawPrice) throw new Error(`invalid price: ${String(item.price)}`);
  const wholesalePrice = (priceUnit === 'cents' ? rawPrice.div(100) : rawPrice).toDecimalPlaces(
    2,
    Prisma.Decimal.ROUND_HALF_UP,
  );

  const lab = normalizeLab(cert.lab);
  const certificateNumber = parseCertificateNumber(cert.certNumber);
  const length = toPositiveDecimal(cert.length, 2);
  const width = toPositiveDecimal(cert.width, 2);
  const discount = item.discount === null || item.discount === undefined ? null : Number(item.discount);

  return {
    source: 'NIVODA',
    sourceStockId: diamond.id,
    supplierName: null,

    lab,
    certificateNumber,
    certificateUrl: certificateLookupUrl(lab, certificateNumber),

    origin,
    shape: normalizeShape(cert.shape),
    carat,
    color: normalizeColor(cert.color),
    clarity: normalizeClarity(cert.clarity),
    cut: normalizeCutGrade(cert.cut),
    polish: normalizeCutGrade(cert.polish),
    symmetry: normalizeCutGrade(cert.symmetry),
    fluorescence: normalizeFluorescence(cert.floInt),

    fancyColor: null,
    fancyIntensity: null,
    fancyOvertone: null,

    lengthMm: length,
    widthMm: width,
    depthMm: toPositiveDecimal(cert.depth, 2),
    lwRatio: length && width ? length.div(width).toDecimalPlaces(2) : null,
    depthPercent: toPositiveDecimal(cert.depthPercentage, 2),
    tablePercent: toPositiveDecimal(cert.table, 2),
    girdle: cert.girdle?.trim() || null,
    culet: null,

    wholesalePrice,
    pricePerCarat: wholesalePrice.div(carat).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
    currency: 'USD',
    rapDiscountPct:
      discount !== null && Number.isFinite(discount)
        ? new Prisma.Decimal(discount).toDecimalPlaces(2)
        : null,

    imageUrl: normalizeUrl(diamond.image),
    videoUrl: normalizeUrl(diamond.video),
    locationCountry: null,
    deliveryDays: null,
    availability: mapAvailability(diamond.availability),

    raw: item as unknown as Prisma.InputJsonValue,
  };
}

// ─── Client ──────────────────────────────────────────────────────────────────

const ITEM_SELECTION = `
  total_count
  items {
    id
    price
    discount
    diamond {
      id
      video
      image
      availability
      supplierStockId
      certificate {
        id lab shape certNumber carats color clarity cut polish symmetry
        floInt floCol length width depth depthPercentage table girdle
      }
    }
  }`;

export interface NivodaSlice {
  origin: StoneOrigin;
  caratBand?: CaratBand;
}

export interface NivodaPage {
  slice: NivodaSlice;
  offset: number;
  totalCount: number;
  items: NivodaItem[];
}

export class NivodaClient {
  private readonly endpoint: string;
  private readonly pageSize: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: NivodaConfig) {
    if (!config.username || !config.password) {
      throw new Error('Nivoda username and password are required');
    }
    this.endpoint = config.endpoint ?? NIVODA_PRODUCTION_URL;
    this.pageSize = Math.min(Math.max(Math.trunc(config.pageSize ?? MAX_PAGE_SIZE), 1), MAX_PAGE_SIZE);
    this.maxRetries = config.maxRetries ?? 4;
    this.timeoutMs = config.requestTimeoutMs ?? 30_000;
    this.fetchImpl = config.fetch ?? fetch;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Exchange username/password for a session token. */
  async authenticate(): Promise<string> {
    // Values are embedded as GraphQL string literals; JSON.stringify produces
    // a valid, fully escaped literal, so credentials cannot alter the query.
    const query = `{
      authenticate {
        username_and_password(
          username: ${JSON.stringify(this.config.username)},
          password: ${JSON.stringify(this.config.password)}
        ) { token }
      }
    }`;
    const data = await this.post<{ authenticate: { username_and_password: { token: string } } }>(query);
    const token = data.authenticate?.username_and_password?.token;
    if (!token) throw new NivodaApiError('Nivoda authentication returned no token');
    this.token = { value: token, expiresAt: Date.now() + TOKEN_TTL_MS };
    return token;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    return this.authenticate();
  }

  /** Fetch one page. Re-authenticates once if the token was rejected. */
  async fetchPage(slice: NivodaSlice, offset: number): Promise<NivodaPage> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      try {
        const data = await this.post<DiamondsPage>(this.buildQuery(token, slice, offset));
        const result = data.as?.diamonds_by_query;
        if (!result) throw new NivodaApiError('Nivoda response is missing diamonds_by_query');
        return {
          slice,
          offset,
          totalCount: Number(result.total_count) || 0,
          items: result.items ?? [],
        };
      } catch (err) {
        if (attempt === 0 && err instanceof NivodaApiError && err.isAuthError) {
          this.token = null;
          continue;
        }
        throw err;
      }
    }
  }

  /** Walk a slice page by page until it is exhausted. */
  async *paginate(slice: NivodaSlice): AsyncGenerator<NivodaPage> {
    const maxPages = this.config.maxPagesPerSlice ?? Number.POSITIVE_INFINITY;
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.fetchPage(slice, offset);
      if (result.items.length === 0) return;
      yield result;
      offset += result.items.length;
      if (offset >= result.totalCount) return;
    }
  }

  private buildQuery(token: string, slice: NivodaSlice, offset: number): string {
    const filters = [`labgrown: ${slice.origin === 'LAB_GROWN'}`];
    if (slice.caratBand) {
      filters.push(`sizes: [{ from: ${Number(slice.caratBand.from)}, to: ${Number(slice.caratBand.to)} }]`);
    }
    // A fixed sort keeps offsets meaningful from one page to the next.
    return `{
      as(token: ${JSON.stringify(token)}) {
        diamonds_by_query(
          query: { ${filters.join(', ')} },
          offset: ${offset},
          limit: ${this.pageSize},
          order: { type: price, direction: ASC }
        ) {${ITEM_SELECTION}
        }
      }
    }`;
  }

  /** POST a query with timeout, and retry with backoff on transient failures. */
  private async post<T>(query: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(Math.min(1000 * 2 ** (attempt - 1), 30_000));
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ query }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = new NivodaApiError(`Nivoda request failed: ${(err as Error).message}`);
        continue; // network error or timeout
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = new NivodaApiError(`Nivoda responded with HTTP ${response.status}`, response.status);
        continue;
      }

      let body: GraphQLResponse<T>;
      try {
        body = (await response.json()) as GraphQLResponse<T>;
      } catch {
        throw new NivodaApiError(`Nivoda returned a non-JSON response (HTTP ${response.status})`, response.status);
      }
      if (body.errors?.length) {
        throw new NivodaApiError(
          `Nivoda GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`,
          response.status,
          body.errors,
        );
      }
      if (!response.ok || !body.data) {
        throw new NivodaApiError(`Nivoda responded with HTTP ${response.status}`, response.status);
      }
      return body.data;
    }
    throw lastError ?? new NivodaApiError('Nivoda request failed');
  }
}

// ─── Ingestion ───────────────────────────────────────────────────────────────

export interface NivodaSyncResult {
  syncRunId: string;
  startedAt: Date;
  finishedAt: Date;
  fetched: number;
  upserted: number;
  rejected: number;
  markedUnavailable: number;
  /** A few rejected records, for diagnostics. */
  rejectedSamples: RejectedRecord[];
}

/**
 * Pull the Nivoda feed into DiamondCache.
 *
 * If any page fails the error propagates and nothing is flagged unavailable,
 * so a broken run can never empty a merchant's catalogue; rows already
 * upserted stay and the next run picks up the rest.
 */
export async function ingestNivoda(db: DiamondCacheDb, config: NivodaConfig): Promise<NivodaSyncResult> {
  const log = config.logger ?? console;
  const client = new NivodaClient(config);
  const priceUnit = config.priceUnit ?? 'cents';
  const syncRunId = randomUUID();
  const startedAt = new Date();

  const origins = config.origins?.length ? config.origins : (['NATURAL', 'LAB_GROWN'] as StoneOrigin[]);
  const slices: NivodaSlice[] = origins.flatMap((origin) =>
    config.caratBands?.length ? config.caratBands.map((caratBand) => ({ origin, caratBand })) : [{ origin }],
  );

  let fetched = 0;
  let upserted = 0;
  let rejected = 0;
  const rejectedSamples: RejectedRecord[] = [];

  for (const slice of slices) {
    for await (const page of client.paginate(slice)) {
      const diamonds: NormalizedDiamond[] = [];
      for (const item of page.items) {
        try {
          diamonds.push(normalizeNivodaItem(item, slice.origin, priceUnit));
        } catch (err) {
          rejected++;
          if (rejectedSamples.length < 20) {
            rejectedSamples.push({ reason: (err as Error).message, record: item });
          }
        }
      }
      fetched += page.items.length;
      upserted += await upsertDiamonds(db, diamonds, syncRunId);
    }
    log.info(`[nivoda] ${slice.origin}${slice.caratBand ? ` ${slice.caratBand.from}-${slice.caratBand.to}ct` : ''} done; ${fetched} fetched so far`);
  }

  // Only a complete, unrestricted run proves a missing stone is really gone.
  const isFullRun =
    config.maxPagesPerSlice === undefined && origins.length === 2 && !config.caratBands?.length;
  const markedUnavailable = isFullRun ? await markUnseenUnavailable(db, 'NIVODA', startedAt) : 0;

  if (rejected > 0) log.warn(`[nivoda] rejected ${rejected} of ${fetched} items`);
  return {
    syncRunId,
    startedAt,
    finishedAt: new Date(),
    fetched,
    upserted,
    rejected,
    markedUnavailable,
    rejectedSamples,
  };
}
