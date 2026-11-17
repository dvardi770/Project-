-- Covering index for storefront search. The search query reads only these
-- columns while filtering, pricing and sorting, so Postgres can answer from the
-- index (about a fifth of the table's size) and fetch full rows for one page.
-- Partial + INCLUDE cannot be declared in schema.prisma.
CREATE INDEX "diamond_cache_search_idx"
  ON "diamond_cache" ("shape", "carat")
  INCLUDE ("id", "source", "origin", "currency", "wholesalePrice", "color", "clarity", "cut", "lab")
  WHERE "availability" = 'AVAILABLE';
