/** Typed client for the storefront API. Response shapes come from the shared contract. */

import type { Bundle, CartItem, Checkout, Diamond, Page, Setting } from '@jewelry/shared/storefront';

export type { Bundle, CartItem, Checkout, Diamond, Money, Page, Setting, SettingVariant } from '@jewelry/shared/storefront';

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
    return this.request<Checkout>('POST', '/api/v1/checkout', undefined, { token });
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
