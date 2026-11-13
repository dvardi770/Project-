# Jewelry SaaS Platform

Connects retail jewelers' storefronts (Shopify, WooCommerce, Wix) to virtual
diamond feeds (Nivoda, RapNet) through an embeddable ring builder.

## Layout

```
.
├── apps/
│   ├── api/                    # Fastify storefront API
│   │   ├── src/
│   │   │   ├── server.ts           # Fastify bootstrap, CORS, route registration
│   │   │   ├── config/env.ts
│   │   │   ├── common/             # tenant auth, cache, errors, bundle token
│   │   │   ├── routes/
│   │   │   │   ├── diamonds.ts     # GET  /api/v1/diamonds
│   │   │   │   ├── settings.ts     # GET  /api/v1/settings
│   │   │   │   ├── cart.ts         # POST /api/v1/bundle, /cart-item, /checkout
│   │   │   │   ├── webhooks.ts     # POST /webhooks/:platform/:tenantId
│   │   │   │   ├── shopifyProxy.ts # Shopify App Proxy: ring builder page + API through the proxy
│   │   │   │   └── widgetAsset.ts  # GET  /widget/jewelry-configurator.js
│   │   │   ├── services/           # bundle resolution, order intake
│   │   │   └── modules/            # dashboard-side features (to come)
│   │   └── test/                   # integration tests (real Postgres)
│   ├── worker/                 # background jobs (one process, or one job per invocation)
│   │   └── src/
│   │       ├── index.ts            # scheduler and `--once <job>` entry point
│   │       └── jobs/
│   │           ├── feedSync.ts     # Nivoda -> DiamondCache, then drops cached searches
│   │           ├── supplierHolds.ts # optional: reserve ordered stones with Nivoda
│   │           └── cartCleanup.ts  # expires checkout sessions, removes one-off cart products
│   ├── dashboard/              # merchant admin (Next.js App Router)
│   │   ├── src/app/
│   │   │   ├── login/              # sign in with the account's secret key
│   │   │   ├── markup-settings/    # markup by carat tier and stone origin
│   │   │   ├── fulfillment/        # order history, "Fulfill Casting via Platform Foundry"
│   │   │   ├── billing/            # subscription status, subscribe, manage
│   │   │   └── api/billing/        # subscribe, portal, Stripe + Shopify webhooks, Shopify return
│   │   ├── src/lib/
│   │   │   ├── billing.ts          # Shopify Billing API + Stripe Subscriptions
│   │   │   ├── markup.ts           # matrix <-> MarkupRule rows
│   │   │   ├── fulfillment.ts      # order list, release to the foundry
│   │   │   └── session.ts          # signed session cookie
│   │   └── test/                   # database-backed tests + browser test
│   └── widget/                 # embeddable ring builder (Lit web component)
│       ├── src/
│       │   ├── jewelry-configurator.ts   # <jewelry-configurator>: 3-step wizard in a shadow root
│       │   ├── api.ts                    # typed storefront API client
│       │   └── cart.ts                   # platform detection + native cart push
│       └── test/e2e.mjs                  # browser test on a hostile host page
├── packages/
│   ├── db/                     # Prisma schema, migrations, generated client
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/
│   │   └── src/
│   ├── feeds/                  # feed adapters + normaliser
│   │   └── src/
│   │       ├── nivoda/nivodaIngestor.ts     # GraphQL auth, pagination, upsert into DiamondCache
│   │       ├── rapnet/rapnetAdapter.ts      # RapNet JSON / CSV -> NormalizedDiamond
│   │       └── normalizer/                  # shared grading vocabulary + DiamondCache writer
│   ├── platforms/              # storefront connectors: checkout creation, webhook verification
│   │   └── src/{shopify,woocommerce,wix}/ + secretBox.ts (credential encryption)
│   ├── pricing/                # markup engine
│   │   └── src/pricingEngine.ts
│   ├── shared/                 # code used by more than one app
│   │   └── src/
│   │       ├── storefront.ts       # storefront API response types (API and widget both use them)
│   │       └── cache.ts            # Redis / in-memory cache and the inventory epoch
│   └── config/                 # shared tsconfig / lint presets
├── integrations/
│   └── wordpress/
│       ├── jewelry-builder/        # the WordPress / WooCommerce plugin (zip this folder)
│       └── tests/run.php           # plugin smoke test against WordPress stand-ins
├── infra/
│   ├── docker/
│   └── terraform/
├── docs/
│   └── adr/                    # architecture decision records
└── .github/workflows/
```

## Development

```
pnpm install        # also generates the Prisma client
pnpm typecheck
pnpm test           # unit tests; API integration tests are skipped without a database
```

Run the API (see `apps/api/.env.example` for the variables):

```
pnpm --filter @jewelry/db migrate:deploy
pnpm dev:api
```

API integration tests need a disposable, migrated Postgres:

```
DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @jewelry/db migrate:deploy
TEST_DATABASE_URL=postgresql://... TEST_REDIS_URL=redis://... pnpm test
```

## Connecting a store

Checkout and order webhooks need the store's credentials, stored encrypted with
`CREDENTIALS_ENCRYPTION_KEY`. Put them in a JSON file and run:

```
pnpm --filter @jewelry/api set-credentials <tenant-slug> ./secrets.json
```

The command prints the webhook URL to register on the store. `secrets.json` is
`{ "credentials": { ... }, "webhookSecret": "..." }` where:

| Platform | `credentials` | `webhookSecret` | Webhook to register |
|---|---|---|---|
| Shopify | `shopDomain` (`x.myshopify.com`), `accessToken` (Admin API, `write_draft_orders`) | the app's API secret | `orders/paid` |
| WooCommerce | `siteUrl` (https), `consumerKey`, `consumerSecret`, `placeholderProductId` (a hidden "Custom Ring" product) | the secret set on the webhook | Order updated |
| Wix | `apiKey`, `siteId` | the Wix app's public key (PEM) | eCommerce Order Approved |

## Purchase flow

1. `POST /api/v1/bundle` validates and prices a setting + stone and returns a signed quote token.
2. The quote is handed to the store in one of two ways, both recorded as a checkout session:
   - `POST /api/v1/cart-item` (Shopify, WooCommerce) creates a one-off product at the quoted price and
     returns its id; the widget adds it with the store's own cart call.
   - `POST /api/v1/checkout` (any platform) creates the order on the platform and returns the URL where
     the shopper pays.
3. The platform calls `POST /webhooks/:platform/:tenantId` when the order is paid. The order is matched
   to its checkout session and becomes a casting order (job bag); the stone is taken out of stock.
   Orders that arrive underpaid, or for a stone that is no longer available, are created `ON_HOLD`.

For the native cart, Shopify credentials also need `write_products` and `write_publications`. One-off
products are created unlisted and tagged `ring-builder-bundle` (Shopify) or hidden from the catalogue (WooCommerce). The
worker deletes each one an hour after its bundle is ordered, or when its checkout session expires
(7 days).

## Installing on a store

Both routes need the tenant to exist and its platform credentials stored (see "Connecting a store"),
and the widget built (`pnpm --filter @jewelry/widget build`). The API serves the built script at
`/widget/jewelry-configurator.js`; set `WIDGET_SCRIPT_URL` if you host it on a CDN instead.

### Shopify (App Proxy)

1. In the Shopify app's configuration, add an App proxy: prefix `apps`, a subpath such as
   `ring-builder`, proxy URL `https://<api-host>/shopify/proxy`.
2. Set `SHOPIFY_APP_SECRET` on the API to the app's client secret. (A store-specific secret saved with
   `set-credentials` as `webhookSecret` is accepted too.)
3. The tenant's `platformStoreId` must be the store's `*.myshopify.com` domain.
4. Link to `/apps/ring-builder` from the store's navigation.

The page is returned as Liquid, so Shopify renders it inside the store's theme with no iframe. The
widget calls the API through the same proxy path, so the merchant enters no API key and registers no
domains: Shopify's signature identifies the store.

### WordPress / WooCommerce (plugin)

1. Issue a publishable key and register the site's domain:
   `pnpm --filter @jewelry/api issue-key <tenant-slug> --domain shop.example.com`
2. Zip `integrations/wordpress/jewelry-builder` and upload it under Plugins > Add New, then activate.
3. Under WooCommerce > Jewelry Builder, enter the API address and the publishable key.
4. Put `[jewelry_builder_widget]` on a page. Optional attributes: `go_to_cart="yes"`, `class="..."`.
5. Add the order webhook under WooCommerce > Settings > Advanced > Webhooks (topic "Order updated").

Plugin check without WordPress: `php integrations/wordpress/tests/run.php`.

## Merchant dashboard

```
pnpm --filter @jewelry/dashboard dev      # http://localhost:3100
pnpm --filter @jewelry/dashboard build && pnpm --filter @jewelry/dashboard start
```

See `apps/dashboard/.env.example`. A merchant signs in with their account's secret key
(`pnpm --filter @jewelry/api issue-key <tenant-slug> --secret`).

- **Markup** edits a table of carat tiers by stone origin. Each cell is stored as a pricing rule, so the
  storefront picks the change up within a minute. Until a markup is saved, nothing is for sale. Rules
  created outside this page (by feed, cost band or priority) are left untouched.
- **Orders** lists the rings bought through the store. "Fulfill Casting via Platform Foundry" moves a
  confirmed order into production at the vendor named by `PLATFORM_FOUNDRY_NAME` and starts its first
  production step. Orders on hold show the reason and cannot be sent until that is resolved.
- **Billing** shows the subscription and starts or manages it.

### Billing setup

One plan, billed monthly. The provider follows the store's platform:

| Store | Billed through | To configure |
|---|---|---|
| Shopify | Shopify Billing API (appears on the merchant's Shopify invoice) | `SHOPIFY_APP_SECRET`; subscribe the app to the `app_subscriptions/update` webhook at `<dashboard>/api/billing/shopify/webhook`. Set `SHOPIFY_BILLING_TEST=true` on development stores. |
| WooCommerce, Wix, custom | Stripe Subscriptions | `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` (a recurring monthly Price), `STRIPE_WEBHOOK_SECRET`; add a webhook endpoint at `<dashboard>/api/billing/stripe/webhook` for `checkout.session.completed`, `customer.subscription.*`, `invoice.paid` and `invoice.payment_failed`. |

The Shopify price comes from `BILLING_PRICE_USD`; the Stripe price is whatever the Stripe Price says, so
keep the two equal. Webhooks keep `Tenant.subscriptionStatus` current, and the storefront API serves
only tenants that are active or trialing: a failed payment switches the store's ring builder off, and a
successful one switches it back on.

Tests: `TEST_DATABASE_URL=... pnpm test` covers billing, markup and fulfilment;
`TEST_DATABASE_URL=... pnpm --filter @jewelry/dashboard test:e2e` drives the built app in a browser.

## Background worker

```
pnpm --filter @jewelry/worker start                 # runs every job on its interval
pnpm --filter @jewelry/worker job feed-sync         # or run one job once and exit
pnpm --filter @jewelry/worker job supplier-holds
pnpm --filter @jewelry/worker job cart-cleanup
```

See `apps/worker/.env.example`. Give it the same `REDIS_URL` and `CREDENTIALS_ENCRYPTION_KEY` as the API.

- **feed-sync** needs `NIVODA_USERNAME` and `NIVODA_PASSWORD` and is skipped without them. It upserts
  the feed, marks stones that left the feed unavailable (only after a complete run), keeps stones that
  are on a live order on hold whatever the feed says, and drops the API's cached searches.
- **supplier-holds** asks Nivoda to hold the centre stone of each newly confirmed order, so it cannot be
  sold elsewhere while the order is processed. It runs only when `NIVODA_AUTO_HOLD=true`. A hold is a
  reservation, not a purchase; if Nivoda declines, the order is put on hold for review.
- **cart-cleanup** marks unpaid checkout sessions past their expiry as expired and removes one-off
  cart products from stores.

## Embedding the ring builder

Build once (`pnpm --filter @jewelry/widget build`) and host `apps/widget/dist/jewelry-configurator.js`.
A store then adds:

```html
<script src="https://cdn.example.com/jewelry-configurator.js" defer></script>
<jewelry-configurator api-base="https://api.example.com" api-key="pk_live_..."></jewelry-configurator>
```

The page's hostname must be one of the tenant's registered domains. `api-base` can instead be a store's
own proxy path (for example `/apps/ring-builder` on Shopify), in which case no key is needed. Optional attributes: `platform`
(`shopify`, `woocommerce` or `auto`), `locale`, and `go-to-cart` to redirect to the cart after adding.

"Add to Cart" uses the store's native cart on Shopify (`/cart/add.js`) and WooCommerce
(`?wc-ajax=add_to_cart`), and falls back to a hosted checkout everywhere else or if the native call fails.

The widget renders in a shadow root, so store CSS cannot restyle it. Stores theme it with CSS custom
properties: `--jc-accent`, `--jc-on-accent`, `--jc-bg`, `--jc-surface`, `--jc-text`, `--jc-muted`,
`--jc-border`, `--jc-radius`, `--jc-font`.

It fires `jc-added-to-cart`, `jc-checkout` and `jc-error` on the element, and
`jewelry-configurator:cart-updated` on `document` so a theme can refresh its cart drawer.

Local demo: `pnpm --filter @jewelry/widget dev`, then open `/?api=http://localhost:4000&key=pk_...` with
the demo origin listed in the API's `CORS_DEV_ORIGINS`. Browser test: `pnpm --filter @jewelry/widget test:e2e`.

## Working with Claude Code

Open this repository in Claude Code. Claude Code reads the root `CLAUDE.md` for project-specific guidance.
