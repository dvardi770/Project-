-- CreateEnum
CREATE TYPE "PlatformType" AS ENUM ('SHOPIFY', 'WOOCOMMERCE', 'WIX', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ApiKeyType" AS ENUM ('PUBLISHABLE', 'SECRET');

-- CreateEnum
CREATE TYPE "FeedSource" AS ENUM ('NIVODA', 'RAPNET');

-- CreateEnum
CREATE TYPE "StoneOrigin" AS ENUM ('NATURAL', 'LAB_GROWN');

-- CreateEnum
CREATE TYPE "DiamondShape" AS ENUM ('ROUND', 'PRINCESS', 'CUSHION', 'OVAL', 'EMERALD', 'PEAR', 'MARQUISE', 'RADIANT', 'ASSCHER', 'HEART', 'OTHER');

-- CreateEnum
CREATE TYPE "GradingLab" AS ENUM ('GIA', 'IGI', 'HRD', 'GCAL', 'AGS', 'OTHER', 'NONE');

-- CreateEnum
CREATE TYPE "DiamondColor" AS ENUM ('D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N_TO_Z');

-- CreateEnum
CREATE TYPE "DiamondClarity" AS ENUM ('FL', 'IF', 'VVS1', 'VVS2', 'VS1', 'VS2', 'SI1', 'SI2', 'SI3', 'I1', 'I2', 'I3');

-- CreateEnum
CREATE TYPE "CutGrade" AS ENUM ('IDEAL', 'EXCELLENT', 'VERY_GOOD', 'GOOD', 'FAIR', 'POOR');

-- CreateEnum
CREATE TYPE "Fluorescence" AS ENUM ('NONE', 'FAINT', 'MEDIUM', 'STRONG', 'VERY_STRONG');

-- CreateEnum
CREATE TYPE "Availability" AS ENUM ('AVAILABLE', 'ON_HOLD', 'SOLD', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "MarkupTarget" AS ENUM ('FEED_DIAMOND', 'MERCHANT_STONE', 'SETTING');

-- CreateEnum
CREATE TYPE "PriceRounding" AS ENUM ('NONE', 'NEAREST_1', 'NEAREST_10', 'NEAREST_100', 'ENDING_99');

-- CreateEnum
CREATE TYPE "MountingStyle" AS ENUM ('SOLITAIRE', 'HALO', 'HIDDEN_HALO', 'PAVE', 'THREE_STONE', 'SIDE_STONE', 'BEZEL', 'CHANNEL', 'VINTAGE', 'TENSION', 'CATHEDRAL', 'OTHER');

-- CreateEnum
CREATE TYPE "MetalType" AS ENUM ('WHITE_GOLD_14K', 'YELLOW_GOLD_14K', 'ROSE_GOLD_14K', 'WHITE_GOLD_18K', 'YELLOW_GOLD_18K', 'ROSE_GOLD_18K', 'PLATINUM_950', 'PALLADIUM_950', 'STERLING_SILVER');

-- CreateEnum
CREATE TYPE "MerchantStockType" AS ENUM ('STONE', 'SETTING');

-- CreateEnum
CREATE TYPE "CastingOrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'IN_PRODUCTION', 'ON_HOLD', 'QC_FAILED', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'CANCELED');

-- CreateEnum
CREATE TYPE "CastingStage" AS ENUM ('CAD_PREP', 'WAX_PRINT', 'CASTING', 'CLEANUP', 'STONE_PROCUREMENT', 'STONE_SETTING', 'POLISHING', 'PLATING', 'ENGRAVING', 'QUALITY_CONTROL', 'PACKAGING');

-- CreateEnum
CREATE TYPE "RouteStepStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "platformType" "PlatformType" NOT NULL,
    "platformStoreId" TEXT,
    "platformCredentialsEnc" BYTEA,
    "platformWebhookSecretEnc" BYTEA,
    "defaultCurrency" CHAR(3) NOT NULL DEFAULT 'USD',
    "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "planCode" TEXT NOT NULL DEFAULT 'starter',
    "billingCustomerId" TEXT,
    "billingSubscriptionId" TEXT,
    "trialEndsAt" TIMESTAMPTZ(3),
    "currentPeriodEndsAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_domains" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "type" "ApiKeyType" NOT NULL,
    "label" TEXT,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feed_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "source" "FeedSource" NOT NULL,
    "credentialsEnc" BYTEA NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastVerifiedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "feed_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "markup_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "target" "MarkupTarget" NOT NULL DEFAULT 'FEED_DIAMOND',
    "feedSource" "FeedSource",
    "origin" "StoneOrigin",
    "caratMin" DECIMAL(6,3),
    "caratMax" DECIMAL(6,3),
    "costMin" DECIMAL(12,2),
    "costMax" DECIMAL(12,2),
    "markupPercent" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "fixedAddition" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "rounding" "PriceRounding" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "markup_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "style" "MountingStyle" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "compatibleShapes" "DiamondShape"[],
    "centerCaratMin" DECIMAL(6,3) NOT NULL,
    "centerCaratMax" DECIMAL(6,3) NOT NULL,
    "cadId" TEXT NOT NULL,
    "cadFileUrl" TEXT,
    "bandWidthMm" DECIMAL(5,2),
    "minRingSize" DECIMAL(4,2),
    "maxRingSize" DECIMAL(4,2),
    "leadTimeDays" INTEGER,
    "video360Url" TEXT,
    "thumbnailUrl" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "virtual_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_setting_variants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "settingId" UUID NOT NULL,
    "metal" "MetalType" NOT NULL,
    "castingCost" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "metalWeightGrams" DECIMAL(7,3),
    "video360Url" TEXT,
    "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "virtual_setting_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setting_side_stones" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "settingId" UUID NOT NULL,
    "position" TEXT,
    "shape" "DiamondShape" NOT NULL,
    "origin" "StoneOrigin" NOT NULL DEFAULT 'NATURAL',
    "quantity" INTEGER NOT NULL,
    "totalCarat" DECIMAL(6,3) NOT NULL,
    "sizeMm" DECIMAL(5,2),
    "colorGrade" TEXT,
    "clarityGrade" TEXT,

    CONSTRAINT "setting_side_stones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diamond_cache" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source" "FeedSource" NOT NULL,
    "sourceStockId" TEXT NOT NULL,
    "supplierName" TEXT,
    "lab" "GradingLab" NOT NULL DEFAULT 'NONE',
    "certificateNumber" TEXT,
    "certificateUrl" TEXT,
    "origin" "StoneOrigin" NOT NULL,
    "shape" "DiamondShape" NOT NULL,
    "carat" DECIMAL(6,3) NOT NULL,
    "color" "DiamondColor",
    "clarity" "DiamondClarity",
    "cut" "CutGrade",
    "polish" "CutGrade",
    "symmetry" "CutGrade",
    "fluorescence" "Fluorescence",
    "fancyColor" TEXT,
    "fancyIntensity" TEXT,
    "fancyOvertone" TEXT,
    "lengthMm" DECIMAL(5,2),
    "widthMm" DECIMAL(5,2),
    "depthMm" DECIMAL(5,2),
    "lwRatio" DECIMAL(4,2),
    "depthPercent" DECIMAL(5,2),
    "tablePercent" DECIMAL(5,2),
    "girdle" TEXT,
    "culet" TEXT,
    "wholesalePrice" DECIMAL(12,2) NOT NULL,
    "pricePerCarat" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "rapDiscountPct" DECIMAL(6,2),
    "imageUrl" TEXT,
    "videoUrl" TEXT,
    "locationCountry" CHAR(2),
    "deliveryDays" INTEGER,
    "availability" "Availability" NOT NULL DEFAULT 'AVAILABLE',
    "raw" JSONB,
    "syncRunId" UUID,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diamond_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_merchant_stock" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "stockType" "MerchantStockType" NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "availability" "Availability" NOT NULL DEFAULT 'AVAILABLE',
    "costPrice" DECIMAL(12,2),
    "retailPrice" DECIMAL(12,2),
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "origin" "StoneOrigin",
    "shape" "DiamondShape",
    "carat" DECIMAL(6,3),
    "color" "DiamondColor",
    "clarity" "DiamondClarity",
    "cut" "CutGrade",
    "polish" "CutGrade",
    "symmetry" "CutGrade",
    "fluorescence" "Fluorescence",
    "lab" "GradingLab",
    "certificateNumber" TEXT,
    "certificateUrl" TEXT,
    "lengthMm" DECIMAL(5,2),
    "widthMm" DECIMAL(5,2),
    "depthMm" DECIMAL(5,2),
    "settingVariantId" UUID,
    "ringSize" DECIMAL(4,2),
    "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "videoUrl" TEXT,
    "uploadBatchId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "custom_merchant_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "casting_vendors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "contactEmail" TEXT,
    "dispatchUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "casting_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "casting_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "jobBagNumber" TEXT NOT NULL,
    "status" "CastingOrderStatus" NOT NULL DEFAULT 'PENDING',
    "currentStage" "CastingStage",
    "externalOrderId" TEXT NOT NULL,
    "externalLineItemId" TEXT,
    "customerReference" TEXT,
    "settingVariantId" UUID NOT NULL,
    "metal" "MetalType" NOT NULL,
    "cadId" TEXT NOT NULL,
    "ringSize" DECIMAL(4,2) NOT NULL,
    "engraving" TEXT,
    "notes" TEXT,
    "centerDiamondId" UUID,
    "centerMerchantStockId" UUID,
    "centerStoneSnapshot" JSONB NOT NULL,
    "castingCost" DECIMAL(12,2) NOT NULL,
    "stoneCost" DECIMAL(12,2) NOT NULL,
    "retailTotal" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "markupRuleId" UUID,
    "vendorId" UUID,
    "dueAt" TIMESTAMPTZ(3),
    "shippedAt" TIMESTAMPTZ(3),
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "canceledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "casting_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "casting_route_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orderId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stage" "CastingStage" NOT NULL,
    "status" "RouteStepStatus" NOT NULL DEFAULT 'PENDING',
    "vendorId" UUID,
    "operator" TEXT,
    "notes" TEXT,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "casting_route_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_billingCustomerId_key" ON "tenants"("billingCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_billingSubscriptionId_key" ON "tenants"("billingSubscriptionId");

-- CreateIndex
CREATE INDEX "tenants_subscriptionStatus_idx" ON "tenants"("subscriptionStatus");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_platformType_platformStoreId_key" ON "tenants"("platformType", "platformStoreId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_domains_hostname_key" ON "tenant_domains"("hostname");

-- CreateIndex
CREATE INDEX "tenant_domains_tenantId_idx" ON "tenant_domains"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_tenantId_type_idx" ON "api_keys"("tenantId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "feed_connections_tenantId_source_key" ON "feed_connections"("tenantId", "source");

-- CreateIndex
CREATE INDEX "markup_rules_tenantId_isActive_target_priority_idx" ON "markup_rules"("tenantId", "isActive", "target", "priority" DESC);

-- CreateIndex
CREATE INDEX "markup_rules_tenantId_origin_caratMin_caratMax_idx" ON "markup_rules"("tenantId", "origin", "caratMin", "caratMax");

-- CreateIndex
CREATE INDEX "virtual_settings_tenantId_isActive_style_idx" ON "virtual_settings"("tenantId", "isActive", "style");

-- CreateIndex
CREATE INDEX "virtual_settings_compatibleShapes_idx" ON "virtual_settings" USING GIN ("compatibleShapes");

-- CreateIndex
CREATE INDEX "virtual_settings_cadId_idx" ON "virtual_settings"("cadId");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_settings_tenantId_sku_key" ON "virtual_settings"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_setting_variants_settingId_metal_key" ON "virtual_setting_variants"("settingId", "metal");

-- CreateIndex
CREATE INDEX "setting_side_stones_settingId_idx" ON "setting_side_stones"("settingId");

-- CreateIndex
CREATE INDEX "diamond_cache_availability_origin_shape_carat_idx" ON "diamond_cache"("availability", "origin", "shape", "carat");

-- CreateIndex
CREATE INDEX "diamond_cache_availability_origin_shape_wholesalePrice_idx" ON "diamond_cache"("availability", "origin", "shape", "wholesalePrice");

-- CreateIndex
CREATE INDEX "diamond_cache_certificateNumber_idx" ON "diamond_cache"("certificateNumber");

-- CreateIndex
CREATE INDEX "diamond_cache_source_lastSyncedAt_idx" ON "diamond_cache"("source", "lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "diamond_cache_source_sourceStockId_key" ON "diamond_cache"("source", "sourceStockId");

-- CreateIndex
CREATE INDEX "custom_merchant_stock_tenantId_stockType_availability_idx" ON "custom_merchant_stock"("tenantId", "stockType", "availability");

-- CreateIndex
CREATE INDEX "custom_merchant_stock_tenantId_origin_shape_carat_idx" ON "custom_merchant_stock"("tenantId", "origin", "shape", "carat");

-- CreateIndex
CREATE INDEX "custom_merchant_stock_settingVariantId_idx" ON "custom_merchant_stock"("settingVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_merchant_stock_tenantId_sku_key" ON "custom_merchant_stock"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "casting_vendors_name_key" ON "casting_vendors"("name");

-- CreateIndex
CREATE UNIQUE INDEX "casting_orders_jobBagNumber_key" ON "casting_orders"("jobBagNumber");

-- CreateIndex
CREATE INDEX "casting_orders_tenantId_status_createdAt_idx" ON "casting_orders"("tenantId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "casting_orders_vendorId_status_dueAt_idx" ON "casting_orders"("vendorId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "casting_orders_settingVariantId_idx" ON "casting_orders"("settingVariantId");

-- CreateIndex
CREATE INDEX "casting_orders_centerDiamondId_idx" ON "casting_orders"("centerDiamondId");

-- CreateIndex
CREATE INDEX "casting_orders_centerMerchantStockId_idx" ON "casting_orders"("centerMerchantStockId");

-- CreateIndex
CREATE INDEX "casting_orders_markupRuleId_idx" ON "casting_orders"("markupRuleId");

-- CreateIndex
CREATE UNIQUE INDEX "casting_orders_tenantId_externalOrderId_externalLineItemId_key" ON "casting_orders"("tenantId", "externalOrderId", "externalLineItemId");

-- CreateIndex
CREATE INDEX "casting_route_steps_vendorId_status_stage_idx" ON "casting_route_steps"("vendorId", "status", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "casting_route_steps_orderId_sequence_key" ON "casting_route_steps"("orderId", "sequence");

-- AddForeignKey
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_connections" ADD CONSTRAINT "feed_connections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markup_rules" ADD CONSTRAINT "markup_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_settings" ADD CONSTRAINT "virtual_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_setting_variants" ADD CONSTRAINT "virtual_setting_variants_settingId_fkey" FOREIGN KEY ("settingId") REFERENCES "virtual_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "setting_side_stones" ADD CONSTRAINT "setting_side_stones_settingId_fkey" FOREIGN KEY ("settingId") REFERENCES "virtual_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_merchant_stock" ADD CONSTRAINT "custom_merchant_stock_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_merchant_stock" ADD CONSTRAINT "custom_merchant_stock_settingVariantId_fkey" FOREIGN KEY ("settingVariantId") REFERENCES "virtual_setting_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_orders" ADD CONSTRAINT "casting_orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_orders" ADD CONSTRAINT "casting_orders_settingVariantId_fkey" FOREIGN KEY ("settingVariantId") REFERENCES "virtual_setting_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_orders" ADD CONSTRAINT "casting_orders_centerDiamondId_fkey" FOREIGN KEY ("centerDiamondId") REFERENCES "diamond_cache"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_orders" ADD CONSTRAINT "casting_orders_centerMerchantStockId_fkey" FOREIGN KEY ("centerMerchantStockId") REFERENCES "custom_merchant_stock"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_orders" ADD CONSTRAINT "casting_orders_markupRuleId_fkey" FOREIGN KEY ("markupRuleId") REFERENCES "markup_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_orders" ADD CONSTRAINT "casting_orders_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "casting_vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_route_steps" ADD CONSTRAINT "casting_route_steps_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "casting_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_route_steps" ADD CONSTRAINT "casting_route_steps_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "casting_vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
