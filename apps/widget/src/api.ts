/** Typed client for the storefront API. Shapes mirror apps/api/src/routes. */

export interface Money {
  amount: string;
  currency: string;
}

export interface SettingVariant {
  id: string;
  metal: string;
  metalWeightGrams: number | null;
  video360Url: string | null;
  imageUrls: string[];
  price: Money;
}

export interface Setting {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  style: string;
  compatibleShapes: string[];
  centerCarat: { min: number; max: number };
  ringSize: { min: number | null; max: number | null };
  leadTimeDays: number | null;
  video360Url: string | null;
  thumbnailUrl: string | null;
  sideStones: { shape: string; quantity: number; totalCarat: number }[];
  variants: SettingVariant[];
  priceFrom: Money;
}

export interface Diamond {
  id: string;
  inventory: 'FEED' | 'MERCHANT';
  origin: 'NATURAL' | 'LAB_GROWN';
  shape: string;
  carat: number;
  color: string | null;
  clarity: string | null;
  cut: string | null;
  polish: string | null;
  symmetry: string | null;
  fluorescence: string | null;
  lab: string;
  certificateNumber: string | null;
  certificateUrl: string | null;
  measurements: { lengthMm: number | null; widthMm: number | null; depthMm: number | null; lwRatio: number | null };
  imageUrl: string | null;
  videoUrl: string | null;
  deliveryDays: number | null;
  price: Money;
}

export interface Page<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalCapped?: boolean;
  hasMore: boolean;
}

export interface Bundle {
  bundleId: string;
  expiresAt: number;
  token: string;
  lineItem: { title: string; sku: string; price: Money; imageUrl: string | null; properties: Record<string, string> };
}

export interface CartItem {
  bundleId: string;
  platform: 'SHOPIFY' | 'WOOCOMMERCE' | 'WIX' | 'CUSTOM';
  purchasableId: string;
  quantity: number;
  properties: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type Query = Record<string, string | number | readonly string[] | null | undefined>;

export class ConfiguratorApi {
  private readonly base: string;

  constructor(
    base: string,
    private readonly apiKey: string,
  ) {
    this.base = base.replace(/\/+$/, '');
  }

  settings(query: Query, signal?: AbortSignal) {
    return this.request<Page<Setting>>('GET', '/api/v1/settings', query, undefined, signal);
  }

  diamonds(query: Query, signal?: AbortSignal) {
    return this.request<Page<Diamond>>('GET', '/api/v1/diamonds', query, undefined, signal);
  }

  bundle(body: {
    settingVariantId: string;
    diamondId: string;
    inventory: 'FEED' | 'MERCHANT';
    ringSize: number;
    engraving?: string;
  }) {
    return this.request<Bundle>('POST', '/api/v1/bundle', undefined, body);
  }

  cartItem(token: string) {
    return this.request<CartItem>('POST', '/api/v1/cart-item', undefined, { token });
  }

  checkout(token: string) {
    return this.request<{ bundleId: string; checkoutUrl: string }>('POST', '/api/v1/checkout', undefined, { token });
  }

  private async request<T>(method: string, path: string, query?: Query, body?: unknown, signal?: AbortSignal): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === null || value === undefined || value === '') continue;
      if (Array.isArray(value)) {
        if (value.length) params.set(key, value.join(','));
      } else {
        params.set(key, String(value));
      }
    }
    const qs = params.toString();

    let response: Response;
    try {
      response = await fetch(`${this.base}${path}${qs ? `?${qs}` : ''}`, {
        method,
        signal,
        // No cookies: the API key identifies the store, and the request stays a simple CORS call.
        credentials: 'omit',
        headers: { 'x-api-key': this.apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection and try again.');
    }

    const payload = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    if (!response.ok) {
      throw new ApiError(
        response.status,
        payload?.error?.code ?? 'error',
        payload?.error?.message ?? `Request failed (${response.status}).`,
      );
    }
    return payload as T;
  }
}
