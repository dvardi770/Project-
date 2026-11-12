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
│   │   │   │   └── cart.ts         # POST /api/v1/bundle
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
│   ├── platforms/              # storefront connectors
│   │   └── src/{shopify,woocommerce,wix}/
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
