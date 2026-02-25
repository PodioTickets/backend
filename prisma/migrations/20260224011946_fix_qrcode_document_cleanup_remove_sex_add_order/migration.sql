-- AlterTable: Remove sex column, add genderDetails and documentNumberClean to User
DO $$ 
BEGIN
  -- Remove sex column if it exists
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'sex') THEN
    ALTER TABLE "User" DROP COLUMN "sex";
  END IF;

  -- Add genderDetails if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'genderDetails') THEN
    ALTER TABLE "User" ADD COLUMN "genderDetails" TEXT;
  END IF;

  -- Add documentNumberClean if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'documentNumberClean') THEN
    ALTER TABLE "User" ADD COLUMN "documentNumberClean" TEXT;
  END IF;

  -- Remove unique constraint from documentNumber if it exists
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_documentNumber_key') THEN
    ALTER TABLE "User" DROP CONSTRAINT "User_documentNumber_key";
  END IF;

  -- Add unique constraint to documentNumberClean if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_documentNumberClean_key') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "User_documentNumberClean_key" ON "User"("documentNumberClean");
  END IF;
END $$;

-- CreateTable: Order
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'Order') THEN
    CREATE TABLE "Order" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL,
        "eventId" UUID NOT NULL,
        "totalAmount" DOUBLE PRECISION NOT NULL,
        "serviceFee" DOUBLE PRECISION NOT NULL,
        "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "finalAmount" DOUBLE PRECISION NOT NULL,
        "couponId" UUID,
        "voucherId" UUID,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
    );
  ELSE
    -- Add eventId column if table exists but column doesn't
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Order' AND column_name = 'eventId') THEN
      ALTER TABLE "Order" ADD COLUMN "eventId" UUID NOT NULL DEFAULT gen_random_uuid();
    END IF;
  END IF;
END $$;

-- CreateIndex: Order indexes
CREATE INDEX IF NOT EXISTS "Order_userId_idx" ON "Order"("userId");
CREATE INDEX IF NOT EXISTS "Order_eventId_idx" ON "Order"("eventId");
CREATE INDEX IF NOT EXISTS "Order_createdAt_idx" ON "Order"("createdAt");

-- AlterTable: Update Registration to link to Order
DO $$
BEGIN
  -- Add orderId column if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Registration' AND column_name = 'orderId') THEN
    ALTER TABLE "Registration" ADD COLUMN "orderId" UUID;
  END IF;

  -- Remove old columns from Registration if they exist
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Registration' AND column_name = 'totalAmount') THEN
    ALTER TABLE "Registration" DROP COLUMN "totalAmount";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Registration' AND column_name = 'serviceFee') THEN
    ALTER TABLE "Registration" DROP COLUMN "serviceFee";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Registration' AND column_name = 'discount') THEN
    ALTER TABLE "Registration" DROP COLUMN "discount";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Registration' AND column_name = 'finalAmount') THEN
    ALTER TABLE "Registration" DROP COLUMN "finalAmount";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Registration' AND column_name = 'purchaseDate') THEN
    ALTER TABLE "Registration" DROP COLUMN "purchaseDate";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Registration' AND column_name = 'couponId') THEN
    ALTER TABLE "Registration" DROP COLUMN "couponId";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Registration' AND column_name = 'voucherId') THEN
    ALTER TABLE "Registration" DROP COLUMN "voucherId";
  END IF;
END $$;

-- CreateIndex: Registration orderId index
CREATE INDEX IF NOT EXISTS "Registration_orderId_idx" ON "Registration"("orderId");
CREATE INDEX IF NOT EXISTS "Registration_orderId_createdAt_idx" ON "Registration"("orderId", "createdAt");

-- AlterTable: Update Payment to link to Order instead of Registration
DO $$
BEGIN
  -- Check if Payment has registrationId and needs to be updated
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Payment' AND column_name = 'registrationId') THEN
    -- Add orderId if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Payment' AND column_name = 'orderId') THEN
      ALTER TABLE "Payment" ADD COLUMN "orderId" UUID;
    END IF;

    -- Migrate data: get orderId from Registration
    UPDATE "Payment" p
    SET "orderId" = r."orderId"
    FROM "Registration" r
    WHERE p."registrationId" = r."id" AND p."orderId" IS NULL;

    -- Remove old foreign key constraint
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_registrationId_fkey') THEN
      ALTER TABLE "Payment" DROP CONSTRAINT "Payment_registrationId_fkey";
    END IF;

    -- Remove old unique constraint
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_registrationId_key') THEN
      ALTER TABLE "Payment" DROP CONSTRAINT "Payment_registrationId_key";
    END IF;

    -- Remove registrationId column
    ALTER TABLE "Payment" DROP COLUMN "registrationId";
  END IF;

  -- Add unique constraint to orderId if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_orderId_key') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "Payment_orderId_key" ON "Payment"("orderId");
  END IF;
END $$;

-- AddForeignKey: Order relations
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_userId_fkey') THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_eventId_fkey') THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_couponId_fkey') THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_voucherId_fkey') THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "Voucher"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Registration_orderId_fkey') THEN
    ALTER TABLE "Registration" ADD CONSTRAINT "Registration_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_orderId_fkey') THEN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
