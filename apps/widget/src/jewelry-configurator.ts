/**
 * <jewelry-configurator> — embeddable ring builder.
 *
 *   <script src="https://cdn.example.com/jewelry-configurator.js" defer></script>
 *   <jewelry-configurator api-base="https://api.example.com" api-key="pk_live_…"></jewelry-configurator>
 *
 * Everything renders inside a shadow root: the host store's CSS cannot reach
 * in, and these styles cannot leak out. Inherited properties (font, colour,
 * line height) do cross a shadow boundary, so the root wrapper resets them. Theming is
 * done on purpose through the --jc-* custom properties, which a store can set
 * from its own stylesheet.
 *
 * Attributes
 *   api-base     Origin of the storefront API, or the store's proxy path such as "/apps/ring-builder" (required)
 *   api-key      The store's publishable key (required unless api-base is a proxy path)
 *   platform     "shopify" | "woocommerce" | "auto" (default): which native cart to use
 *   locale       BCP 47 tag for number formatting (default: the page's language)
 *   go-to-cart   Present: redirect to the cart after adding instead of confirming in place
 *
 * Events (bubble out of the shadow root)
 *   jc-added-to-cart  { bundleId, title, price, platform, cartUrl }
 *   jc-checkout       { bundleId, checkoutUrl }   fired just before redirecting
 *   jc-error          { code, message }
 */
import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ApiError, ConfiguratorApi, type Diamond, type Money, type Setting, type SettingVariant } from './api';
import { addToShopifyCart, addToWooCommerceCart, detectPlatform, type StorefrontPlatform } from './cart';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

const METALS = [
  'WHITE_GOLD_14K',
  'YELLOW_GOLD_14K',
  'ROSE_GOLD_14K',
  'WHITE_GOLD_18K',
  'YELLOW_GOLD_18K',
  'ROSE_GOLD_18K',
  'PLATINUM_950',
] as const;

const STYLES = ['SOLITAIRE', 'HALO', 'HIDDEN_HALO', 'PAVE', 'THREE_STONE', 'SIDE_STONE', 'BEZEL', 'VINTAGE', 'CATHEDRAL'] as const;

/** Best to worst; the colour slider moves along this scale. */
const COLORS = ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'] as const;

/** Slider stops for retail price; the last stop means "no upper limit". */
const PRICE_STOPS = [0, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 30000, 50000, 75000, 100000];

const SORTS = [
  ['price_asc', 'Price: low to high'],
  ['price_desc', 'Price: high to low'],
  ['carat_desc', 'Carat: high to low'],
  ['carat_asc', 'Carat: low to high'],
] as const;

const SWATCH: Record<string, string> = {
  WHITE_GOLD: 'linear-gradient(135deg,#f4f4f2,#c9cbcd)',
  YELLOW_GOLD: 'linear-gradient(135deg,#f6e3a1,#d4a938)',
  ROSE_GOLD: 'linear-gradient(135deg,#f5d0c0,#d8957c)',
  PLATINUM: 'linear-gradient(135deg,#eef0f2,#aeb4ba)',
  PALLADIUM: 'linear-gradient(135deg,#eceef0,#b9bec4)',
  STERLING: 'linear-gradient(135deg,#f2f2f2,#bdbdbd)',
};

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** WHITE_GOLD_14K → "14K White Gold", PLATINUM_950 → "Platinum 950". */
const metalLabel = (metal: string) => {
  const karat = metal.match(/^(.*)_(\d+K)$/);
  return karat ? `${karat[2]} ${titleCase(karat[1]!)}` : titleCase(metal);
};

const swatch = (metal: string) =>
  SWATCH[Object.keys(SWATCH).find((k) => metal.startsWith(k)) ?? ''] ?? 'linear-gradient(135deg,#eee,#bbb)';

/** Only https URLs are ever placed in src/href: catalogue data is not trusted markup. */
const safeUrl = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

const isVideoFile = (url: string) => /\.(mp4|webm|mov)(\?|#|$)/i.test(url);

type Step = 1 | 2 | 3;
type CartState =
  | { phase: 'idle' }
  | { phase: 'working'; message: string }
  | { phase: 'added'; cartUrl: string; title: string }
  | { phase: 'error'; message: string };

// ─── Component ───────────────────────────────────────────────────────────────

@customElement('jewelry-configurator')
export class JewelryConfigurator extends LitElement {
  @property({ attribute: 'api-base' }) apiBase = '';
  @property({ attribute: 'api-key' }) apiKey = '';
  @property() platform: 'auto' | 'shopify' | 'woocommerce' = 'auto';
  @property() locale = '';
  @property({ type: Boolean, attribute: 'go-to-cart' }) goToCart = false;

  @state() private step: Step = 1;

  // Step 1
  @state() private settings: Setting[] = [];
  @state() private settingsLoading = false;
  @state() private settingsError = '';
  @state() private metalFilter = '';
  @state() private styleFilter = '';
  @state() private setting: Setting | null = null;
  @state() private variant: SettingVariant | null = null;

  // Step 2
  @state() private diamonds: Diamond[] = [];
  @state() private diamondsTotal = 0;
  @state() private diamondsCapped = false;
  @state() private diamondsHasMore = false;
  @state() private diamondsLoading = false;
  @state() private diamondsError = '';
  @state() private shapes: string[] = [];
  @state() private origin: '' | 'NATURAL' | 'LAB_GROWN' = '';
  @state() private carat: [number, number] = [0.3, 5];
  @state() private color: [number, number] = [0, COLORS.length - 1];
  @state() private price: [number, number] = [0, PRICE_STOPS.length];
  @state() private sort: string = 'price_asc';
  @state() private diamond: Diamond | null = null;
  /** Filters start collapsed when the widget is narrow, so results are visible first. */
  @state() private filtersOpen = true;

  // Step 3
  @state() private ringSize = 6;
  @state() private engraving = '';
  @state() private show360 = false;
  @state() private cart: CartState = { phase: 'idle' };
  /** The chosen diamond sold while the shopper was deciding. */
  @state() private diamondGone = false;

  private api: ConfiguratorApi | null = null;
  private settingsAbort: AbortController | null = null;
  private diamondsAbort: AbortController | null = null;
  private diamondsTimer: ReturnType<typeof setTimeout> | undefined;
  private diamondsPage = 1;

  /**
   * An absolute api-base is another origin and needs the store's key. A path
   * such as "/apps/ring-builder" is the store's own proxy, which signs requests.
   */
  private get configured(): boolean {
    if (!this.apiBase) return false;
    return this.apiBase.startsWith('/') && !this.apiBase.startsWith('//') ? true : !!this.apiKey;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('apiBase') || changed.has('apiKey')) {
      this.api = this.configured ? new ConfiguratorApi(this.apiBase, this.apiKey) : null;
      if (this.api) void this.loadSettings();
    }
  }

  protected firstUpdated(): void {
    this.filtersOpen = this.getBoundingClientRect().width > 760;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.settingsAbort?.abort();
    this.diamondsAbort?.abort();
    clearTimeout(this.diamondsTimer);
  }

  // ─── Data ──────────────────────────────────────────────────────────────────

  private async loadSettings(): Promise<void> {
    if (!this.api) return;
    this.settingsAbort?.abort();
    const abort = (this.settingsAbort = new AbortController());
    this.settingsLoading = true;
    this.settingsError = '';
    try {
      const page = await this.api.settings({ metal: this.metalFilter, style: this.styleFilter, limit: 60 }, abort.signal);
      this.settings = page.data;
      // Keep the current choice only if it survived the new filter.
      const kept = this.setting && page.data.find((s) => s.id === this.setting!.id);
      if (kept) this.pickSetting(kept, this.variant?.metal);
      else {
        this.setting = null;
        this.variant = null;
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      this.settingsError = this.describe(err);
    } finally {
      if (this.settingsAbort === abort) this.settingsLoading = false;
    }
  }

  private pickSetting(setting: Setting, preferMetal?: string): void {
    const changed = this.setting?.id !== setting.id;
    this.setting = setting;
    this.variant = setting.variants.find((v) => v.metal === preferMetal) ?? setting.variants[0] ?? null;
    if (!changed) return;

    // A new setting changes which stones fit: reset the stone and its filters.
    this.diamond = null;
    this.shapes = [];
    const lo = Math.max(0.1, setting.centerCarat.min);
    const hi = Math.max(lo, setting.centerCarat.max);
    this.carat = [lo, hi];
    const min = setting.ringSize.min ?? 3;
    const max = setting.ringSize.max ?? 13;
    this.ringSize = Math.min(Math.max(6, min), max);
  }

  private pickDiamond(d: Diamond): void {
    this.diamond = d;
    this.diamondGone = false;
  }

  /** Debounced: sliders fire continuously while dragged. */
  private queueDiamondSearch(): void {
    clearTimeout(this.diamondsTimer);
    this.diamondsLoading = true;
    this.diamondsTimer = setTimeout(() => void this.loadDiamonds(false), 250);
  }

  private async loadDiamonds(append: boolean): Promise<void> {
    if (!this.api || !this.setting) return;
    this.diamondsAbort?.abort();
    const abort = (this.diamondsAbort = new AbortController());
    this.diamondsLoading = true;
    this.diamondsError = '';
    this.diamondsPage = append ? this.diamondsPage + 1 : 1;

    const [colorLo, colorHi] = this.color;
    const allColors = colorLo === 0 && colorHi === COLORS.length - 1;
    const [priceLo, priceHi] = this.price;
    try {
      const page = await this.api.diamonds(
        {
          // Never ask for a shape the chosen setting cannot hold.
          shape: this.shapes.length ? this.shapes : this.setting.compatibleShapes,
          origin: this.origin,
          caratMin: this.carat[0],
          caratMax: this.carat[1],
          color: allColors ? undefined : COLORS.slice(colorLo, colorHi + 1),
          priceMin: priceLo > 0 ? PRICE_STOPS[priceLo] : undefined,
          priceMax: priceHi < PRICE_STOPS.length ? PRICE_STOPS[priceHi] : undefined,
          sort: this.sort,
          page: this.diamondsPage,
          limit: 24,
        },
        abort.signal,
      );
      this.diamonds = append ? [...this.diamonds, ...page.data] : page.data;
      this.diamondsTotal = page.total;
      this.diamondsCapped = page.totalCapped ?? false;
      this.diamondsHasMore = page.hasMore;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      this.diamondsError = this.describe(err);
    } finally {
      if (this.diamondsAbort === abort) this.diamondsLoading = false;
    }
  }

  private describe(err: unknown): string {
    const message = err instanceof Error ? err.message : 'Something went wrong.';
    const code = err instanceof ApiError ? err.code : 'error';
    this.dispatchEvent(new CustomEvent('jc-error', { detail: { code, message }, bubbles: true, composed: true }));
    return message;
  }

  // ─── Navigation ────────────────────────────────────────────────────────────

  private canEnter(step: Step): boolean {
    if (step === 1) return true;
    if (step === 2) return !!this.variant;
    return !!this.variant && !!this.diamond;
  }

  private go(step: Step): void {
    if (!this.canEnter(step)) return;
    this.step = step;
    this.cart = { phase: 'idle' };
    this.show360 = false;
    if (step === 2 && this.diamonds.length === 0) void this.loadDiamonds(false);
    // Bring the top of the widget into view; it may sit far down a long page.
    void this.updateComplete.then(() => {
      const top = this.getBoundingClientRect().top;
      if (top < 0) this.scrollIntoView({ behavior: 'smooth', block: 'start' });
      this.renderRoot.querySelector<HTMLElement>('h2')?.focus();
    });
  }

  // ─── Cart ──────────────────────────────────────────────────────────────────

  private resolvePlatform(): StorefrontPlatform {
    if (this.platform === 'shopify') return 'SHOPIFY';
    if (this.platform === 'woocommerce') return 'WOOCOMMERCE';
    return detectPlatform();
  }

  private async addToCart(): Promise<void> {
    if (!this.api || !this.variant || !this.diamond || this.cart.phase === 'working') return;
    const api = this.api;
    this.cart = { phase: 'working', message: 'Confirming price and availability…' };

    try {
      // The server re-checks the stone, the fit and the price; its answer is the quote.
      const bundle = await api.bundle({
        settingVariantId: this.variant.id,
        diamondId: this.diamond.id,
        inventory: this.diamond.inventory,
        ringSize: this.ringSize,
        engraving: this.engraving.trim() || undefined,
      });

      const platform = this.resolvePlatform();
      if (platform !== 'UNKNOWN') {
        this.cart = { phase: 'working', message: 'Adding to your cart…' };
        try {
          const item = await api.cartItem(bundle.token);
          if (item.platform === platform) {
            const result =
              platform === 'SHOPIFY'
                ? await addToShopifyCart({ variantId: item.purchasableId, properties: item.properties })
                : await addToWooCommerceCart({ productId: item.purchasableId });
            this.dispatchEvent(
              new CustomEvent('jc-added-to-cart', {
                detail: { bundleId: bundle.bundleId, title: bundle.lineItem.title, price: bundle.lineItem.price, platform, cartUrl: result.cartUrl },
                bubbles: true,
                composed: true,
              }),
            );
            if (this.goToCart) window.location.assign(result.cartUrl);
            else this.cart = { phase: 'added', cartUrl: result.cartUrl, title: bundle.lineItem.title };
            return;
          }
        } catch (err) {
          // A stone that sold in the meantime is a real stop; anything else
          // about the native cart falls back to a hosted checkout below.
          if (err instanceof ApiError && !['native_cart_unsupported', 'platform_error'].includes(err.code)) throw err;
          console.warn('[jewelry-configurator] native cart unavailable, using checkout:', err);
        }
      }

      this.cart = { phase: 'working', message: 'Taking you to secure checkout…' };
      const checkout = await api.checkout(bundle.token);
      this.dispatchEvent(new CustomEvent('jc-checkout', { detail: checkout, bubbles: true, composed: true }));
      window.location.assign(checkout.checkoutUrl);
    } catch (err) {
      const message = this.describe(err);
      this.cart = { phase: 'error', message };
      if (err instanceof ApiError && err.code === 'diamond_unavailable') {
        // Take the sold stone out of the list so the shopper is not sent back to it.
        this.diamonds = this.diamonds.filter((d) => d.id !== this.diamond?.id);
        this.diamondGone = true;
      }
    }
  }

  private replaceDiamond(): void {
    this.diamond = null;
    this.diamondGone = false;
    this.go(2);
  }

  private startOver(): void {
    this.diamond = null;
    this.engraving = '';
    this.cart = { phase: 'idle' };
    this.diamonds = [];
    this.go(1);
  }

  // ─── Formatting ────────────────────────────────────────────────────────────

  private money(m: Money | { amount: number; currency: string }): string {
    const amount = Number(m.amount);
    try {
      return new Intl.NumberFormat(this.locale || document.documentElement.lang || undefined, {
        style: 'currency',
        currency: m.currency,
        maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      }).format(amount);
    } catch {
      return `${m.currency} ${amount.toFixed(2)}`;
    }
  }

  private get total(): Money | null {
    if (!this.variant || !this.diamond) return null;
    if (this.variant.price.currency !== this.diamond.price.currency) return null;
    return {
      amount: (Number(this.variant.price.amount) + Number(this.diamond.price.amount)).toFixed(2),
      currency: this.variant.price.currency,
    };
  }

  private diamondTitle(d: Diamond): string {
    return `${d.carat.toFixed(2)} ct ${titleCase(d.shape)}${d.origin === 'LAB_GROWN' ? ' · Lab-Grown' : ''}`;
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  protected render(): TemplateResult {
    if (!this.configured) {
      return html`<div class="root notice error" role="alert">
        The ring builder is not configured: set <code>api-base</code>, and <code>api-key</code> unless the API is reached through
        the store's own proxy path.
      </div>`;
    }
    return html`
      <div class="root jc">
        ${this.renderStepper()}
        <div class="body">
          ${this.step === 1 ? this.renderSettings() : this.step === 2 ? this.renderDiamonds() : this.renderSummary()}
        </div>
        ${this.renderFooter()}
      </div>
    `;
  }

  private renderStepper(): TemplateResult {
    const steps: [Step, string, string][] = [
      [1, 'Setting', this.setting?.name ?? 'Choose a setting'],
      [2, 'Diamond', this.diamond ? this.diamondTitle(this.diamond) : 'Choose a diamond'],
      [3, 'Review', this.total ? this.money(this.total) : 'Your ring'],
    ];
    return html`
      <nav aria-label="Ring builder steps">
        <ol class="steps">
          ${steps.map(
            ([n, label, detail]) => html`
              <li>
                <button
                  type="button"
                  class=${this.step === n ? 'current' : n < this.step ? 'done' : ''}
                  aria-current=${this.step === n ? 'step' : nothing}
                  ?disabled=${!this.canEnter(n)}
                  @click=${() => this.go(n)}
                >
                  <span class="num" aria-hidden="true">${n < this.step ? '✓' : n}</span>
                  <span class="txt"><b>${label}</b><small>${detail}</small></span>
                </button>
              </li>
            `,
          )}
        </ol>
      </nav>
    `;
  }

  // ── Step 1 ──

  private renderSettings(): TemplateResult {
    return html`
      <h2 tabindex="-1">Choose your setting</h2>
      <div class="filters-row">
        <label class="field">
          <span>Metal</span>
          <select
            @change=${(e: Event) => {
              this.metalFilter = (e.target as HTMLSelectElement).value;
              void this.loadSettings();
            }}
          >
            <option value="" ?selected=${!this.metalFilter}>All metals</option>
            ${METALS.map((m) => html`<option value=${m} ?selected=${this.metalFilter === m}>${metalLabel(m)}</option>`)}
          </select>
        </label>
        <div class="chips" role="group" aria-label="Style">
          ${['', ...STYLES].map(
            (s) => html`
              <button
                type="button"
                class="chip"
                aria-pressed=${this.styleFilter === s}
                @click=${() => {
                  this.styleFilter = s;
                  void this.loadSettings();
                }}
              >
                ${s ? titleCase(s) : 'All styles'}
              </button>
            `,
          )}
        </div>
      </div>

      ${this.settingsError
        ? html`<div class="notice error" role="alert">
            ${this.settingsError} <button type="button" class="link" @click=${() => this.loadSettings()}>Try again</button>
          </div>`
        : nothing}

      <div class="grid" aria-busy=${this.settingsLoading}>
        ${this.settingsLoading && this.settings.length === 0
          ? Array.from({ length: 6 }, () => html`<div class="card skeleton" aria-hidden="true"></div>`)
          : this.settings.map((s) => this.renderSettingCard(s))}
      </div>
      ${!this.settingsLoading && !this.settingsError && this.settings.length === 0
        ? html`<p class="empty">No settings match these filters.</p>`
        : nothing}
    `;
  }

  private renderSettingCard(s: Setting): TemplateResult {
    const selected = this.setting?.id === s.id;
    const shown = selected && this.variant ? this.variant : s.variants[0];
    const image = safeUrl(shown?.imageUrls[0]) ?? safeUrl(s.thumbnailUrl);
    return html`
      <article class="card ${selected ? 'selected' : ''}">
        <button type="button" class="card-main" aria-pressed=${selected} @click=${() => this.pickSetting(s, this.variant?.metal)}>
          <span class="thumb">
            ${image ? html`<img src=${image} alt="" loading="lazy" />` : html`<span class="ph" aria-hidden="true">◇</span>`}
          </span>
          <span class="card-name">${s.name}</span>
          <span class="card-meta">${titleCase(s.style)}</span>
          <span class="card-price">${selected && this.variant ? this.money(this.variant.price) : html`From ${this.money(s.priceFrom)}`}</span>
        </button>
        ${selected
          ? html`
              <div class="swatches" role="group" aria-label="Metal for ${s.name}">
                ${s.variants.map(
                  (v) => html`
                    <button
                      type="button"
                      class="swatch"
                      title=${metalLabel(v.metal)}
                      aria-label="${metalLabel(v.metal)}, ${this.money(v.price)}"
                      aria-pressed=${this.variant?.id === v.id}
                      @click=${() => (this.variant = v)}
                    >
                      <i style="background:${swatch(v.metal)}"></i>
                    </button>
                  `,
                )}
                <span class="swatch-label">${this.variant ? metalLabel(this.variant.metal) : ''}</span>
              </div>
            `
          : nothing}
      </article>
    `;
  }

  // ── Step 2 ──

  private renderDiamonds(): TemplateResult {
    const s = this.setting!;
    const caratLo = Math.max(0.1, s.centerCarat.min);
    const caratHi = Math.max(caratLo, s.centerCarat.max);
    const priceLabel = (i: number) => (i >= PRICE_STOPS.length ? 'No limit' : this.money({ amount: PRICE_STOPS[i]!, currency: this.variant!.price.currency }));
    const count = this.diamondsCapped ? `${this.diamondsTotal.toLocaleString()}+` : this.diamondsTotal.toLocaleString();

    return html`
      <h2 tabindex="-1">Choose your diamond</h2>
      <div class="split">
        <details
          class="filters"
          ?open=${this.filtersOpen}
          @toggle=${(e: Event) => (this.filtersOpen = (e.target as HTMLDetailsElement).open)}
        >
          <summary>Filters</summary>
          <div class="filters-inner">
            <fieldset>
              <legend>Shape</legend>
              <div class="chips">
                ${s.compatibleShapes.map(
                  (shape) => html`
                    <button
                      type="button"
                      class="chip"
                      aria-pressed=${this.shapes.includes(shape)}
                      @click=${() => {
                        this.shapes = this.shapes.includes(shape) ? this.shapes.filter((x) => x !== shape) : [...this.shapes, shape];
                        this.queueDiamondSearch();
                      }}
                    >
                      ${titleCase(shape)}
                    </button>
                  `,
                )}
              </div>
            </fieldset>

            <fieldset>
              <legend>Origin</legend>
              <div class="chips">
                ${([['', 'All'], ['NATURAL', 'Natural'], ['LAB_GROWN', 'Lab-Grown']] as const).map(
                  ([value, label]) => html`
                    <button
                      type="button"
                      class="chip"
                      aria-pressed=${this.origin === value}
                      @click=${() => {
                        this.origin = value;
                        this.queueDiamondSearch();
                      }}
                    >
                      ${label}
                    </button>
                  `,
                )}
              </div>
            </fieldset>

            ${this.renderRange({
              label: 'Carat',
              min: caratLo,
              max: caratHi,
              step: 0.05,
              value: this.carat,
              format: (v) => `${v.toFixed(2)} ct`,
              onChange: (v) => (this.carat = v),
            })}
            ${this.renderRange({
              label: 'Colour',
              min: 0,
              max: COLORS.length - 1,
              step: 1,
              value: this.color,
              format: (v) => COLORS[v] ?? '',
              onChange: (v) => (this.color = v),
            })}
            ${this.renderRange({
              label: 'Price',
              min: 0,
              max: PRICE_STOPS.length,
              step: 1,
              value: this.price,
              format: priceLabel,
              onChange: (v) => (this.price = v),
            })}
          </div>
        </details>

        <section class="results" aria-busy=${this.diamondsLoading}>
          <div class="results-head">
            <span aria-live="polite">${this.diamondsLoading && !this.diamonds.length ? 'Searching…' : `${count} diamonds`}</span>
            <label class="field inline">
              <span class="sr">Sort by</span>
              <select
                @change=${(e: Event) => {
                  this.sort = (e.target as HTMLSelectElement).value;
                  void this.loadDiamonds(false);
                }}
              >
                ${SORTS.map(([value, label]) => html`<option value=${value} ?selected=${this.sort === value}>${label}</option>`)}
              </select>
            </label>
          </div>

          ${this.diamondsError
            ? html`<div class="notice error" role="alert">
                ${this.diamondsError}
                <button type="button" class="link" @click=${() => this.loadDiamonds(false)}>Try again</button>
              </div>`
            : nothing}

          <ul class="stones ${this.diamondsLoading ? 'loading' : ''}">
            ${this.diamonds.map((d) => this.renderDiamondRow(d))}
          </ul>
          ${!this.diamondsLoading && !this.diamondsError && this.diamonds.length === 0
            ? html`<p class="empty">No diamonds match these filters. Try widening the carat, colour or price range.</p>`
            : nothing}
          ${this.diamondsHasMore
            ? html`<button type="button" class="btn ghost more" ?disabled=${this.diamondsLoading} @click=${() => this.loadDiamonds(true)}>
                ${this.diamondsLoading ? 'Loading…' : 'Show more diamonds'}
              </button>`
            : nothing}
        </section>
      </div>
    `;
  }

  private renderRange(o: {
    label: string;
    min: number;
    max: number;
    step: number;
    value: [number, number];
    format: (v: number) => string;
    onChange: (v: [number, number]) => void;
  }): TemplateResult {
    const [lo, hi] = o.value;
    const span = o.max - o.min || 1;
    const pct = (v: number) => ((v - o.min) / span) * 100;
    const set = (which: 0 | 1, raw: string) => {
      const v = Number(raw);
      // The two thumbs may meet but never cross.
      o.onChange(which === 0 ? [Math.min(v, hi), hi] : [lo, Math.max(v, lo)]);
      this.queueDiamondSearch();
    };
    return html`
      <fieldset class="range">
        <legend class="sr">${o.label}</legend>
        <div class="range-head" aria-hidden="true">
          <span>${o.label}</span>
          <output>${o.format(lo)} – ${o.format(hi)}</output>
        </div>
        <div class="track" style="--lo:${pct(lo)}%;--hi:${pct(hi)}%">
          <input
            type="range"
            aria-label="Minimum ${o.label.toLowerCase()}"
            aria-valuetext=${o.format(lo)}
            min=${o.min}
            max=${o.max}
            step=${o.step}
            .value=${String(lo)}
            @input=${(e: Event) => set(0, (e.target as HTMLInputElement).value)}
          />
          <input
            type="range"
            aria-label="Maximum ${o.label.toLowerCase()}"
            aria-valuetext=${o.format(hi)}
            min=${o.min}
            max=${o.max}
            step=${o.step}
            .value=${String(hi)}
            @input=${(e: Event) => set(1, (e.target as HTMLInputElement).value)}
          />
        </div>
      </fieldset>
    `;
  }

  private renderDiamondRow(d: Diamond): TemplateResult {
    const selected = this.diamond?.id === d.id;
    const image = safeUrl(d.imageUrl);
    const grades = [d.color && `${d.color} colour`, d.clarity, d.cut && `${titleCase(d.cut)} cut`].filter(Boolean);
    return html`
      <li class="stone ${selected ? 'selected' : ''}">
        <span class="thumb small">
          ${image ? html`<img src=${image} alt="" loading="lazy" />` : html`<span class="ph" aria-hidden="true">◇</span>`}
        </span>
        <span class="stone-info">
          <b>${this.diamondTitle(d)}</b>
          <small>${grades.join(' · ')}</small>
          <small class="muted">
            ${d.lab !== 'NONE' ? `${d.lab} certified` : 'Uncertified'}${d.inventory === 'MERCHANT' ? ' · In our showroom' : ''}
          </small>
        </span>
        <span class="stone-price">${this.money(d.price)}</span>
        <button type="button" class="btn ${selected ? '' : 'ghost'} small" aria-pressed=${selected} @click=${() => this.pickDiamond(d)}>
          ${selected ? 'Selected' : 'Select'}<span class="sr"> ${this.diamondTitle(d)}, ${this.money(d.price)}</span>
        </button>
      </li>
    `;
  }

  // ── Step 3 ──

  private renderSummary(): TemplateResult {
    const s = this.setting!;
    const v = this.variant!;
    const d = this.diamond!;
    const render = safeUrl(v.imageUrls[0]) ?? safeUrl(s.thumbnailUrl);
    const spin = safeUrl(v.video360Url ?? s.video360Url);
    const stoneImage = safeUrl(d.imageUrl);
    const stoneVideo = safeUrl(d.videoUrl);
    const cert = safeUrl(d.certificateUrl);
    const min = s.ringSize.min ?? 3;
    const max = s.ringSize.max ?? 13;
    const sizes: number[] = [];
    for (let size = min; size <= max + 1e-9; size += 0.5) sizes.push(Math.round(size * 2) / 2);

    if (this.cart.phase === 'added') {
      return html`
        <div class="added" role="status">
          <span class="tick" aria-hidden="true">✓</span>
          <h2 tabindex="-1">Added to your cart</h2>
          <p>${this.cart.title}</p>
          <div class="actions">
            <a class="btn" href=${this.cart.cartUrl}>View cart</a>
            <button type="button" class="btn ghost" @click=${() => this.startOver()}>Build another ring</button>
          </div>
        </div>
      `;
    }

    return html`
      <h2 tabindex="-1">Review your ring</h2>
      <div class="review">
        <div class="gallery">
          <div class="hero">
            ${this.show360 && spin
              ? isVideoFile(spin)
                ? html`<video src=${spin} autoplay loop muted playsinline controls></video>`
                : html`<iframe src=${spin} title="360° view of ${s.name}" loading="lazy" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe>`
              : render
                ? html`<img src=${render} alt="${s.name} in ${metalLabel(v.metal)}" />`
                : html`<span class="ph" aria-hidden="true">◇</span>`}
          </div>
          <div class="gallery-row">
            ${spin
              ? html`<button type="button" class="btn ghost small" aria-pressed=${this.show360} @click=${() => (this.show360 = !this.show360)}>
                  ${this.show360 ? 'Show photo' : 'View in 360°'}
                </button>`
              : nothing}
            ${stoneImage ? html`<span class="thumb small"><img src=${stoneImage} alt="${this.diamondTitle(d)}" loading="lazy" /></span>` : nothing}
            ${stoneVideo ? html`<a class="link" href=${stoneVideo} target="_blank" rel="noopener noreferrer">Diamond video ↗</a>` : nothing}
          </div>
        </div>

        <div class="summary">
          <dl class="lines">
            <div>
              <dt>
                <b>${s.name}</b>
                <small>${metalLabel(v.metal)}</small>
                <button type="button" class="link" @click=${() => this.go(1)}>Change</button>
              </dt>
              <dd>${this.money(v.price)}</dd>
            </div>
            <div>
              <dt>
                <b>${this.diamondTitle(d)}</b>
                <small>${[d.color && `${d.color} colour`, d.clarity, d.cut && `${titleCase(d.cut)} cut`].filter(Boolean).join(' · ')}</small>
                <small>
                  ${d.lab !== 'NONE' && d.certificateNumber
                    ? cert
                      ? html`<a class="link" href=${cert} target="_blank" rel="noopener noreferrer">${d.lab} ${d.certificateNumber} ↗</a>`
                      : `${d.lab} ${d.certificateNumber}`
                    : nothing}
                </small>
                <button type="button" class="link" @click=${() => this.go(2)}>Change</button>
              </dt>
              <dd>${this.money(d.price)}</dd>
            </div>
            <div class="total">
              <dt>Total</dt>
              <dd>${this.total ? this.money(this.total) : '—'}</dd>
            </div>
          </dl>

          <div class="options">
            <label class="field">
              <span>Ring size</span>
              <select @change=${(e: Event) => (this.ringSize = Number((e.target as HTMLSelectElement).value))}>
                ${sizes.map((size) => html`<option value=${size} ?selected=${this.ringSize === size}>${size}</option>`)}
              </select>
            </label>
            <label class="field grow">
              <span>Engraving <em>(optional)</em></span>
              <input
                type="text"
                maxlength="40"
                placeholder="Up to 40 characters"
                .value=${this.engraving}
                @input=${(e: Event) => (this.engraving = (e.target as HTMLInputElement).value)}
              />
            </label>
          </div>

          ${s.leadTimeDays ? html`<p class="muted">Made to order. Usually ready in ${s.leadTimeDays} days.</p>` : nothing}
          ${this.cart.phase === 'error' ? html`<div class="notice error" role="alert">${this.cart.message}</div>` : nothing}
          ${this.diamondGone
            ? html`<button type="button" class="btn ghost" @click=${() => this.replaceDiamond()}>Choose another diamond</button>`
            : nothing}
        </div>
      </div>
    `;
  }

  // ── Footer ──

  private renderFooter(): TemplateResult | typeof nothing {
    if (this.cart.phase === 'added') return nothing;
    const working = this.cart.phase === 'working';
    const summary =
      this.step === 1
        ? this.variant
          ? html`<b>${this.setting!.name}</b><small>${metalLabel(this.variant.metal)} · ${this.money(this.variant.price)}</small>`
          : html`<small>Select a setting to continue</small>`
        : this.step === 2
          ? this.diamond
            ? html`<b>${this.diamondTitle(this.diamond)}</b><small>${this.money(this.diamond.price)}${this.total ? ` · Ring total ${this.money(this.total)}` : ''}</small>`
            : html`<small>Select a diamond to continue</small>`
          : html`<small>Total</small><b class="big">${this.total ? this.money(this.total) : '—'}</b>`;

    return html`
      <footer class="bar">
        ${this.step > 1
          ? html`<button type="button" class="btn ghost" ?disabled=${working} @click=${() => this.go((this.step - 1) as Step)}>Back</button>`
          : html`<span></span>`}
        <span class="bar-summary" aria-live="polite">${working ? html`<small>${(this.cart as { message: string }).message}</small>` : summary}</span>
        ${this.step === 3
          ? html`<button type="button" class="btn primary" ?disabled=${working || !this.total || this.diamondGone} @click=${() => this.addToCart()}>
              ${working ? html`<span class="spinner" aria-hidden="true"></span>` : nothing} Add to Cart
            </button>`
          : html`<button type="button" class="btn primary" ?disabled=${!this.canEnter((this.step + 1) as Step)} @click=${() => this.go((this.step + 1) as Step)}>
              ${this.step === 1 ? 'Choose a diamond' : 'Review ring'}
            </button>`}
      </footer>
    `;
  }

  // ─── Styles ────────────────────────────────────────────────────────────────

  static styles = css`
    :host {
      display: block;
      container-type: inline-size;
    }
    /*
     * The reset lives on an element inside the shadow root, not on :host. A
     * store rule such as "* { font-family: x !important }" does match the host
     * element and would win there, and its value would then inherit inward.
     * Nothing outside can match .root, so inheritance stops here.
     */
    .root {
      all: initial;
      display: block;
      font-family: var(--jc-font, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif);
      font-size: 16px;
      line-height: 1.45;
      color: var(--jc-text, #1c1b1a);
      -webkit-text-size-adjust: 100%;

      --_bg: var(--jc-bg, #ffffff);
      --_surface: var(--jc-surface, #faf9f7);
      --_border: var(--jc-border, #e3e0da);
      --_muted: var(--jc-muted, #6b6862);
      --_accent: var(--jc-accent, #1c1b1a);
      --_on-accent: var(--jc-on-accent, #ffffff);
      --_radius: var(--jc-radius, 10px);
      --_danger: #a4262c;
    }
    :host([hidden]) {
      display: none;
    }
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }
    .jc {
      background: var(--_bg);
      border: 1px solid var(--_border);
      border-radius: calc(var(--_radius) + 4px);
      overflow: clip;
    }
    .body {
      padding: 20px;
    }
    h2 {
      margin: 0 0 16px;
      font-size: 1.35rem;
      font-weight: 600;
      letter-spacing: -0.01em;
      outline: none;
    }
    small {
      font-size: 0.8125rem;
    }
    .muted,
    small.muted {
      color: var(--_muted);
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    button,
    select,
    input {
      font: inherit;
      color: inherit;
    }
    button {
      cursor: pointer;
    }
    button:disabled {
      cursor: not-allowed;
    }
    :focus-visible {
      outline: 2px solid var(--_accent);
      outline-offset: 2px;
    }

    /* Stepper */
    .steps {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      margin: 0;
      padding: 0;
      list-style: none;
      border-bottom: 1px solid var(--_border);
      background: var(--_surface);
    }
    .steps button {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 14px 16px;
      background: none;
      border: 0;
      border-bottom: 2px solid transparent;
      text-align: left;
      color: var(--_muted);
    }
    .steps button.current {
      color: inherit;
      border-bottom-color: var(--_accent);
      background: var(--_bg);
    }
    .steps button.done {
      color: inherit;
    }
    .steps button:disabled {
      opacity: 0.55;
    }
    .num {
      flex: none;
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      border: 1px solid currentColor;
      font-size: 0.8125rem;
      font-weight: 600;
    }
    .current .num,
    .done .num {
      background: var(--_accent);
      border-color: var(--_accent);
      color: var(--_on-accent);
    }
    .txt {
      display: grid;
      min-width: 0;
    }
    .txt small {
      color: var(--_muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Controls */
    .field {
      display: grid;
      gap: 4px;
      font-size: 0.875rem;
    }
    .field > span {
      font-weight: 600;
    }
    .field em {
      font-weight: 400;
      font-style: normal;
      color: var(--_muted);
    }
    .field.grow {
      flex: 1 1 200px;
    }
    select,
    input[type='text'] {
      min-height: 42px;
      padding: 8px 12px;
      background: var(--_bg);
      border: 1px solid var(--_border);
      border-radius: var(--_radius);
      width: 100%;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .chip {
      padding: 7px 14px;
      min-height: 36px;
      background: var(--_bg);
      border: 1px solid var(--_border);
      border-radius: 999px;
      font-size: 0.875rem;
    }
    .chip[aria-pressed='true'] {
      background: var(--_accent);
      border-color: var(--_accent);
      color: var(--_on-accent);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 44px;
      padding: 10px 20px;
      background: var(--_accent);
      border: 1px solid var(--_accent);
      border-radius: var(--_radius);
      color: var(--_on-accent);
      font-weight: 600;
      text-decoration: none;
      white-space: nowrap;
    }
    .btn.ghost {
      background: transparent;
      color: inherit;
      border-color: var(--_border);
    }
    .btn.small {
      min-height: 36px;
      padding: 6px 14px;
      font-size: 0.875rem;
    }
    .btn:disabled {
      opacity: 0.45;
    }
    .link {
      padding: 0;
      background: none;
      border: 0;
      color: inherit;
      font-size: 0.8125rem;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .notice {
      margin: 12px 0;
      padding: 12px 14px;
      border-radius: var(--_radius);
      font-size: 0.875rem;
    }
    .notice.error {
      background: #fdf3f3;
      border: 1px solid #f0c7c9;
      color: var(--_danger);
    }
    .empty {
      padding: 32px 0;
      text-align: center;
      color: var(--_muted);
    }

    /* Step 1 */
    .filters-row {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 16px;
      margin-bottom: 20px;
    }
    .filters-row .field {
      flex: 0 0 200px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
      gap: 16px;
    }
    .card {
      display: flex;
      flex-direction: column;
      min-width: 0;
      align-self: start;
      border: 1px solid var(--_border);
      border-radius: var(--_radius);
      background: var(--_bg);
      overflow: hidden;
    }
    .card.selected {
      border-color: var(--_accent);
      box-shadow: 0 0 0 1px var(--_accent);
    }
    .card.skeleton {
      min-height: 260px;
      background: linear-gradient(100deg, var(--_surface) 40%, #f0eee9 50%, var(--_surface) 60%) 0 0 / 200% 100%;
      animation: shimmer 1.4s linear infinite;
    }
    @keyframes shimmer {
      to {
        background-position: -200% 0;
      }
    }
    .card-main {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
      padding: 0 0 12px;
      background: none;
      border: 0;
      text-align: left;
    }
    .card-main > :not(.thumb) {
      padding: 0 12px;
    }
    .thumb {
      display: grid;
      place-items: center;
      aspect-ratio: 1;
      margin-bottom: 10px;
      background: var(--_surface);
      overflow: hidden;
    }
    .thumb.small {
      flex: none;
      width: 64px;
      margin: 0;
      border-radius: 8px;
    }
    .thumb img,
    .hero img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .ph {
      font-size: 2rem;
      color: #c9c5bc;
    }
    .card-name {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .card-meta {
      font-size: 0.8125rem;
      color: var(--_muted);
    }
    .card-price {
      margin-top: 4px;
      font-size: 0.9375rem;
    }
    .swatches {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 10px 12px 12px;
      border-top: 1px solid var(--_border);
    }
    .swatch {
      width: 30px;
      height: 30px;
      padding: 3px;
      background: none;
      border: 1px solid transparent;
      border-radius: 50%;
    }
    .swatch i {
      display: block;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      border: 1px solid rgb(0 0 0 / 0.15);
    }
    .swatch[aria-pressed='true'] {
      border-color: var(--_accent);
    }
    .swatch-label {
      flex-basis: 100%;
      font-size: 0.8125rem;
      color: var(--_muted);
    }

    /* Step 2 */
    .split {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      gap: 24px;
      align-items: start;
    }
    .filters > summary {
      display: none;
      padding: 10px 14px;
      border: 1px solid var(--_border);
      border-radius: var(--_radius);
      font-weight: 600;
      cursor: pointer;
    }
    .filters-inner {
      display: grid;
      gap: 20px;
    }
    fieldset {
      min-width: 0;
      margin: 0;
      padding: 0;
      border: 0;
    }
    legend {
      padding: 0;
      margin-bottom: 8px;
      font-size: 0.875rem;
      font-weight: 600;
    }
    .range-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 0.875rem;
      font-weight: 600;
    }
    .range-head output {
      font-size: 0.8125rem;
      font-weight: 400;
      color: var(--_muted);
    }
    .track {
      position: relative;
      height: 28px;
    }
    .track::before,
    .track::after {
      content: '';
      position: absolute;
      top: 12px;
      height: 4px;
      border-radius: 2px;
    }
    .track::before {
      left: 0;
      right: 0;
      background: var(--_border);
    }
    .track::after {
      left: var(--lo);
      right: calc(100% - var(--hi));
      background: var(--_accent);
    }
    /* Two native sliders stacked: only the thumbs take pointer events. */
    .track input {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 28px;
      margin: 0;
      padding: 0;
      background: none;
      border: 0;
      pointer-events: none;
      -webkit-appearance: none;
      appearance: none;
      z-index: 1;
    }
    .track input::-webkit-slider-runnable-track {
      background: none;
    }
    .track input::-moz-range-track {
      background: none;
    }
    .track input::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 24px;
      height: 24px;
      margin-top: 2px;
      border-radius: 50%;
      background: var(--_bg);
      border: 2px solid var(--_accent);
      pointer-events: auto;
      cursor: grab;
    }
    .track input::-moz-range-thumb {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--_bg);
      border: 2px solid var(--_accent);
      pointer-events: auto;
      cursor: grab;
    }
    .results-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
      font-size: 0.875rem;
      color: var(--_muted);
    }
    .field.inline select {
      min-height: 36px;
      padding: 4px 10px;
      color: var(--jc-text, #1c1b1a);
    }
    .stones {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
      transition: opacity 0.15s;
    }
    .stones.loading {
      opacity: 0.55;
    }
    .stone {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 14px;
      padding: 10px;
      border: 1px solid var(--_border);
      border-radius: var(--_radius);
    }
    .stone.selected {
      border-color: var(--_accent);
      box-shadow: 0 0 0 1px var(--_accent);
    }
    .stone-info {
      display: grid;
      min-width: 0;
    }
    .stone-price {
      font-weight: 600;
      white-space: nowrap;
    }
    .more {
      width: 100%;
      margin-top: 12px;
    }

    /* Step 3 */
    .review {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
      gap: 28px;
      align-items: start;
    }
    .hero {
      display: grid;
      place-items: center;
      aspect-ratio: 1;
      background: var(--_surface);
      border-radius: var(--_radius);
      overflow: hidden;
    }
    .hero iframe,
    .hero video {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
    }
    .hero .ph {
      font-size: 5rem;
    }
    .gallery-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
    }
    .lines {
      margin: 0;
    }
    .lines > div {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 0;
      border-bottom: 1px solid var(--_border);
    }
    .lines dt {
      display: grid;
      gap: 2px;
      justify-items: start;
    }
    .lines dt small {
      color: var(--_muted);
    }
    .lines dd {
      margin: 0;
      font-weight: 600;
      white-space: nowrap;
    }
    .lines .total {
      border-bottom: 0;
      font-size: 1.25rem;
      font-weight: 600;
    }
    .options {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin: 8px 0 12px;
    }
    .options .field:first-child {
      flex: 0 0 110px;
    }
    .added {
      display: grid;
      justify-items: center;
      gap: 8px;
      padding: 40px 16px;
      text-align: center;
    }
    .added h2 {
      margin: 0;
    }
    .added p {
      margin: 0;
      color: var(--_muted);
    }
    .tick {
      display: grid;
      place-items: center;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--_accent);
      color: var(--_on-accent);
      font-size: 1.5rem;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 12px;
      margin-top: 16px;
    }

    /* Footer bar */
    .bar {
      position: sticky;
      bottom: 0;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 16px;
      padding: 12px 20px;
      background: var(--_bg);
      border-top: 1px solid var(--_border);
    }
    .bar-summary {
      display: grid;
      justify-items: end;
      min-width: 0;
      text-align: right;
    }
    .bar-summary small {
      color: var(--_muted);
    }
    .bar-summary > * {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .big {
      font-size: 1.25rem;
    }
    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    /* The widget's own width, not the viewport's, decides the layout. */
    @container (max-width: 760px) {
      .split,
      .review {
        grid-template-columns: minmax(0, 1fr);
      }
      .filters > summary {
        display: block;
        margin-bottom: 12px;
      }
      .filters:not([open]) > summary {
        margin-bottom: 0;
      }
    }
    @container (max-width: 560px) {
      .body {
        padding: 14px;
      }
      .steps button {
        flex-direction: column;
        align-items: center;
        gap: 4px;
        padding: 10px 6px;
        text-align: center;
      }
      .txt small {
        display: none;
      }
      .grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .filters-row .field {
        flex: 1 1 100%;
      }
      .stone {
        grid-template-columns: auto minmax(0, 1fr) auto;
      }
      .stone .btn {
        grid-column: 1 / -1;
      }
      .bar {
        grid-template-columns: auto minmax(0, 1fr);
        gap: 8px 10px;
        padding: 10px 14px;
      }
      /* One line of summary above a single row of buttons. */
      .bar-summary {
        grid-column: 1 / -1;
        grid-row: 1;
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 10px;
        text-align: left;
      }
      .bar > span:first-child {
        display: none;
      }
      .bar .btn.primary {
        grid-column: 2;
      }
      .bar > span:first-child + .bar-summary + .btn.primary {
        grid-column: 1 / -1;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      * {
        animation: none !important;
        transition: none !important;
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'jewelry-configurator': JewelryConfigurator;
  }
}
