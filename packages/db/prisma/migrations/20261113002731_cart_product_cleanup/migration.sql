-- AlterTable
ALTER TABLE "checkout_sessions" ADD COLUMN     "externalProductId" TEXT,
ADD COLUMN     "productDeletedAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "checkout_sessions_productDeletedAt_expiresAt_idx" ON "checkout_sessions"("productDeletedAt", "expiresAt");

