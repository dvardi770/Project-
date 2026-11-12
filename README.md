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
│   │   │   │   ├── cart.ts         # POST /api/v1/bundle, POST /api/v1/checkout
│   │   │   │   └── webhooks.ts     # POST /webhooks/:platform/:tenantId
│   │   │   ├── services/           # bundle resolution, order intake
│   │   │   └── modules/            # dashboard-side features (to come)
│   │   └── test/                   # integration tests (real Postgres)
│   ├── worker/                 # background jobs
│   │   └── src/jobs/
│   │       ├── feed-sync/          # Nivoda / RapNet -> DiamondCache
│   │       ├── cache-prune/        # mark stale diamonds unavailable
│   │       ├── platform-sync/      # push products / orders to storefronts
│   │       └── casting-dispatch/   # send job tickets to casting vendors
│   ├── dashboard/              # merchant admin web app
│   │   └── src/{app,components,lib}/
│   └── widget/                 # embeddable ring builder (script + iframe)
│       └── src/{steps,components,state,embed}/
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
│   ├── shared/                 # cross-app types, validation schemas, constants
│   │   └── src/{types,schemas,constants}/
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
2. `POST /api/v1/checkout` takes the token, records a checkout session and creates the order on the
   store's platform at the quoted price, returning the URL where the shopper pays.
3. The platform calls `POST /webhooks/:platform/:tenantId` when the order is paid. The order is matched
   to its checkout session and becomes a casting order (job bag); the stone is taken out of stock.
   Orders that arrive underpaid, or for a stone that is no longer available, are created `ON_HOLD`.

## Working with Claude Code

Open this repository in Claude Code. Claude Code reads the root `CLAUDE.md` for project-specific guidance.
