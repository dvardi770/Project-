# Claude Code guidance

## Project context

B2B SaaS that connects retail jewelers' storefronts (Shopify, WooCommerce, Wix) to virtual diamond
feeds (Nivoda; RapNet adapter present but unused) through an embeddable ring builder. See `README.md`
for the layout, purchase flow and store setup.

- TypeScript pnpm workspace, Node 20+. Packages export their TypeScript source directly (run with `tsx`).
- `packages/db` — Prisma 6 schema and migrations (PostgreSQL). Partial indexes and check constraints
  live in hand-written migrations because the schema language cannot express them.
- `packages/pricing` — markup engine. It is the single source of truth for retail prices; the SQL in
  `apps/api/src/routes/diamonds.ts` mirrors it only for filtering and sorting.
- `packages/feeds` — Nivoda ingestor, RapNet adapter, shared grading normaliser.
- `packages/platforms` — storefront connectors and credential encryption.
- `apps/api` — Fastify storefront API.
- `apps/widget` — Lit web component (`<jewelry-configurator>`), built by Vite into one ASCII-only script.
- `apps/worker` — background jobs: Nivoda feed sync, supplier holds, checkout-session / cart-product cleanup.
- `packages/shared` — `storefront.ts` is the API response contract used by the widget; the API proves
  its DTOs match it in `apps/api/src/contract.ts`. `cache.ts` is the cache shared by API and worker.
- `integrations/wordpress/jewelry-builder` — the WooCommerce plugin (PHP, WordPress coding style, tabs).
- `apps/dashboard` is a placeholder.

## Commands

```
pnpm install                                  # also generates the Prisma client
pnpm typecheck
pnpm test                                     # unit tests; API integration tests skip without a database
DATABASE_URL=... pnpm --filter @jewelry/db migrate:deploy
TEST_DATABASE_URL=... [TEST_REDIS_URL=...] pnpm test   # full suite, needs a disposable migrated Postgres
pnpm dev:api
php integrations/wordpress/tests/run.php     # plugin smoke test (stand-ins for WordPress, no WP needed)
pnpm --filter @jewelry/widget test:e2e       # builds the widget and drives it in Chromium (needs Playwright's browser)
```

New migrations: `prisma migrate dev` needs an interactive terminal; in a non-interactive session
generate SQL with `prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script`.

## Things to know

- Wholesale price, supplier name, casting cost and CAD ids must never appear in API responses.
- An item that no markup rule prices is not for sale and must look like it does not exist.
- Vendor integrations were checked against primary sources, not live accounts: Nivoda's published
  examples (bitbucket.org/nivoda/nivoda-api), the Shopify Admin GraphQL schema and `@shopify/shopify-api`,
  Wix's SDK packages, and WooCommerce's source. None has been run against a real store or account.
- Not established by any source: whether Nivoda's `price` is in cents (assumed; `NIVODA_PRICE_UNIT`).
  Nivoda documents cents for its price *filters* only. The feed sync refuses to write anything if the
  cheapest stones' per-carat prices are implausible for the configured unit (`assertPlausiblePrices`).
- The WordPress plugin was exercised on a real WordPress 6.4 site, but without WooCommerce installed.
- A stone on a live casting order stays `ON_HOLD` locally. The worker can also place a Nivoda hold
  (`NIVODA_AUTO_HOLD=true`, off by default). Nothing ever buys a stone automatically.
- Test files that use the database run one at a time (`fileParallelism: false`) and truncate it first.

## Working agreements

- Follow the conventions already present in the repository; keep changes focused and consistent.
- Before changing files, inspect the relevant code and configuration.
- Do not add dependencies, credentials, or generated files unless the task requires them.
- Never commit secrets. Use environment variables for sensitive configuration and document required variable names without including their values.
- Run the available relevant tests, linters, and build checks after changes. If none are configured, say so rather than inventing commands.
- Update the README when setup, usage, or project behavior changes.
