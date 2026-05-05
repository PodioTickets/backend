ALTER TABLE "Voucher" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Voucher_deletedAt_idx" ON "Voucher"("deletedAt");
