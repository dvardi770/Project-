-- AlterTable
ALTER TABLE "casting_orders" ADD COLUMN     "supplierHoldAttemptedAt" TIMESTAMPTZ(3),
ADD COLUMN     "supplierHoldId" TEXT,
ADD COLUMN     "supplierHoldUntil" TIMESTAMPTZ(3);

