-- Rings and bands designed in the 3D builders can be ordered: a checkout session and a casting
-- order describe either a catalogue setting with a centre stone, or a custom design.
ALTER TABLE "casting_orders" ADD COLUMN     "customDesign" JSONB,
ALTER COLUMN "settingVariantId" DROP NOT NULL,
ALTER COLUMN "metal" DROP NOT NULL,
ALTER COLUMN "cadId" DROP NOT NULL;

ALTER TABLE "checkout_sessions" ADD COLUMN     "customDesign" JSONB,
ALTER COLUMN "settingVariantId" DROP NOT NULL,
ALTER COLUMN "stoneSource" DROP NOT NULL,
ALTER COLUMN "stoneId" DROP NOT NULL,
ALTER COLUMN "ringSize" DROP NOT NULL;

-- Exactly one of the two descriptions, complete.
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_setting_or_design"
  CHECK (("customDesign" IS NULL AND "settingVariantId" IS NOT NULL AND "stoneSource" IS NOT NULL AND "stoneId" IS NOT NULL AND "ringSize" IS NOT NULL)
      OR ("customDesign" IS NOT NULL AND "settingVariantId" IS NULL AND "stoneId" IS NULL));
ALTER TABLE "casting_orders" ADD CONSTRAINT "casting_orders_setting_or_design"
  CHECK (("customDesign" IS NULL AND "settingVariantId" IS NOT NULL AND "metal" IS NOT NULL AND "cadId" IS NOT NULL)
      OR ("customDesign" IS NOT NULL AND "settingVariantId" IS NULL));
