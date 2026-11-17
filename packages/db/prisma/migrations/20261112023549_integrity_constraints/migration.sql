-- Rules Prisma's schema language cannot express.

-- Platform-catalogue settings have a NULL tenantId, and NULLs are distinct in
-- a unique index, so their SKUs need their own uniqueness guarantee.
CREATE UNIQUE INDEX "virtual_settings_platform_sku_key"
  ON "virtual_settings" ("sku")
  WHERE "tenantId" IS NULL;

-- A job bag has at most one centre-stone reference.
ALTER TABLE "casting_orders"
  ADD CONSTRAINT "casting_orders_single_center_stone"
  CHECK (num_nonnulls("centerDiamondId", "centerMerchantStockId") <= 1);

-- Range bounds must be ordered.
ALTER TABLE "markup_rules"
  ADD CONSTRAINT "markup_rules_carat_range"
  CHECK ("caratMin" IS NULL OR "caratMax" IS NULL OR "caratMin" < "caratMax"),
  ADD CONSTRAINT "markup_rules_cost_range"
  CHECK ("costMin" IS NULL OR "costMax" IS NULL OR "costMin" < "costMax");
