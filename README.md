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
│   │   │   │   └── webhooks.ts     # POST /webhooks/:platform/:tenantId
│   │   │   ├── services/           # bundle resolution, order intake
│   │   │   └── modules/            # dashboard-side features (to come)
│   │   └── test/                   # integration tests (real Postgres)
│   ├── worker/                 # background jobs (one process, or one job per invocation)
│   │   └── src/
│   │       ├── index.ts            # scheduler and `--once <job>` entry point
│   │       └── jobs/
│   │           ├── feedSync.ts     # Nivoda -> DiamondCache, then drops cached searches
│   │           └── cartCleanup.ts  # expires checkout sessions, removes one-off cart products
│   ├── dashboard/              # merchant admin web app
│   │   └── src/{app,components,lib}/
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
products are tagged `ring-builder-bundle` (Shopify) or hidden from the catalogue (WooCommerce). The
worker deletes each one an hour after its bundle is ordered, or when its checkout session expires
(7 days).

## Background worker

```
pnpm --filter @jewelry/worker start                 # runs every job on its interval
pnpm --filter @jewelry/worker job feed-sync         # or run one job once and exit
pnpm --filter @jewelry/worker job cart-cleanup
```

See `apps/worker/.env.example`. Give it the same `REDIS_URL` and `CREDENTIALS_ENCRYPTION_KEY` as the API.

- **feed-sync** needs `NIVODA_USERNAME` and `NIVODA_PASSWORD` and is skipped without them. It upserts
  the feed, marks stones that left the feed unavailable (only after a complete run), keeps stones that
  are on a live order on hold whatever the feed says, and drops the API's cached searches.
- **cart-cleanup** marks unpaid checkout sessions past their expiry as expired and removes one-off
  cart products from stores.

## Embedding the ring builder

Build once (`pnpm --filter @jewelry/widget build`) and host `apps/widget/dist/jewelry-configurator.js`.
A store then adds:

```html
<script src="https://cdn.example.com/jewelry-configurator.js" defer></script>
<jewelry-configurator api-base="https://api.example.com" api-key="pk_live_..."></jewelry-configurator>
```

The page's hostname must be one of the tenant's registered domains. Optional attributes: `platform`
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
