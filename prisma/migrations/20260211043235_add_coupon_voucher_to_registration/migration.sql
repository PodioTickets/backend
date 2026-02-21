-- AlterTable
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "couponId" UUID,
ADD COLUMN IF NOT EXISTS "voucherId" UUID;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Registration_couponId_fkey'
  ) THEN
    ALTER TABLE "Registration" ADD CONSTRAINT "Registration_couponId_fkey" 
    FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Registration_voucherId_fkey'
  ) THEN
    ALTER TABLE "Registration" ADD CONSTRAINT "Registration_voucherId_fkey" 
    FOREIGN KEY ("voucherId") REFERENCES "Voucher"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
