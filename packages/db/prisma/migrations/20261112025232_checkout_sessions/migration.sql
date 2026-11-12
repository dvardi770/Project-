-- CreateEnum
CREATE TYPE "StoneSource" AS ENUM ('FEED', 'MERCHANT');

-- CreateEnum
CREATE TYPE "CheckoutStatus" AS ENUM ('OPEN', 'ORDERED', 'EXPIRED');

-- AlterTable
ALTER TABLE "casting_orders" ADD COLUMN     "checkoutSessionId" UUID;

-- CreateTable
CREATE TABLE "checkout_sessions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "platform" "PlatformType" NOT NULL,
    "status" "CheckoutStatus" NOT NULL DEFAULT 'OPEN',
    "externalCheckoutId" TEXT,
    "checkoutUrl" TEXT,
    "settingVariantId" UUID NOT NULL,
    "stoneSource" "StoneSource" NOT NULL,
    "stoneId" UUID NOT NULL,
    "ringSize" DECIMAL(4,2) NOT NULL,
    "engraving" TEXT,
    "settingPrice" DECIMAL(12,2) NOT NULL,
    "stonePrice" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "stoneMarkupRuleId" UUID,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "checkout_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checkout_sessions_tenantId_status_idx" ON "checkout_sessions"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_sessions_tenantId_externalCheckoutId_key" ON "checkout_sessions"("tenantId", "externalCheckoutId");

-- CreateIndex
CREATE UNIQUE INDEX "casting_orders_checkoutSessionId_key" ON "casting_orders"("checkoutSessionId");

-- AddForeignKey
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_orders" ADD CONSTRAINT "casting_orders_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "checkout_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

