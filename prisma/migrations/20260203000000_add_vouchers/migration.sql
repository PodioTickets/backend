-- CreateEnum
CREATE TYPE "VoucherStatus" AS ENUM ('ACTIVE', 'USED', 'EXPIRED', 'INACTIVE');

-- AlterTable
ALTER TABLE "Coupon" ALTER COLUMN "code" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Voucher" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "eventId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "appliesTo" TEXT,
    "expiryDate" TIMESTAMP(3),
    "cpfListStatus" "CpfListStatus" NOT NULL DEFAULT 'DISABLED',
    "cpfList" JSONB,
    "status" "VoucherStatus" NOT NULL DEFAULT 'ACTIVE',
    "usedAt" TIMESTAMP(3),
    "usedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_code_key" ON "Voucher"("code");

-- CreateIndex
CREATE INDEX "Voucher_eventId_idx" ON "Voucher"("eventId");

-- CreateIndex
CREATE INDEX "Voucher_code_idx" ON "Voucher"("code");

-- CreateIndex
CREATE INDEX "Voucher_status_idx" ON "Voucher"("status");

-- CreateIndex
CREATE INDEX "Voucher_eventId_status_idx" ON "Voucher"("eventId", "status");

-- CreateIndex
CREATE INDEX "Voucher_code_status_idx" ON "Voucher"("code", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_eventId_code_key" ON "Voucher"("eventId", "code");

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
