-- Add soft delete support to Coupon
ALTER TABLE "public"."Coupon" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "Coupon_deletedAt_idx" ON "public"."Coupon"("deletedAt");
