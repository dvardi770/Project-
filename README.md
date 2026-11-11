# Jewelry SaaS Platform

Connects retail jewelers' storefronts (Shopify, WooCommerce, Wix) to virtual
diamond feeds (Nivoda, RapNet) through an embeddable ring builder.

## Layout

```
.
├── apps/
│   ├── api/                    # HTTP API (merchant dashboard + public storefront endpoints)
│   │   ├── src/
│   │   │   ├── common/         # guards, tenant-context middleware, error handling
│   │   │   ├── config/
│   │   │   └── modules/
│   │   │       ├── auth/               # API-key + session auth, domain allow-list
│   │   │       ├── tenants/
│   │   │       ├── billing/            # subscription lifecycle
│   │   │       ├── markup-rules/
│   │   │       ├── virtual-settings/
│   │   │       ├── diamonds/           # search over DiamondCache + merchant stock
│   │   │       ├── merchant-stock/     # CSV / dashboard uploads
│   │   │       ├── casting-orders/     # job-bag creation and routing
│   │   │       ├── storefront/         # endpoints consumed by the widget
│   │   │       └── webhooks/           # Shopify / Woo / Wix / billing webhooks
│   │   └── test/
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
│   │   └── src/{nivoda,rapnet,normalizer}/
│   ├── platforms/              # storefront connectors
│   │   └── src/{shopify,woocommerce,wix}/
│   ├── pricing/                # markup engine (pure functions over MarkupRule)
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
