/*
  Warnings:

  - A unique constraint covering the columns `[slug]` on the table `Event` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[googleId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum (using IF NOT EXISTS pattern)
DO $$ BEGIN
 CREATE TYPE "CouponType" AS ENUM ('DISCOUNT', 'QUANTITY', 'AGE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENTAGE', 'FIXED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 CREATE TYPE "CouponStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'EXPIRED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 CREATE TYPE "CpfListStatus" AS ENUM ('DISABLED', 'ENABLED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- DropIndex (Event_slug_idx may not exist, using IF EXISTS)
DROP INDEX IF EXISTS "public"."Event_slug_idx";

-- AlterTable (check if column exists first)
DO $$ BEGIN
 ALTER TABLE "KitItem" ADD COLUMN "productId" UUID;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "Modality" ADD COLUMN "groupId" UUID;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;

-- CreateTable (using IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS "ModalityGroup" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "eventId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModalityGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable (using IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS "Coupon" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "eventId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "couponType" "CouponType" NOT NULL,
    "type" "CouponDiscountType" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "appliesTo" TEXT,
    "expiryDate" TIMESTAMP(3),
    "minCartValue" DOUBLE PRECISION,
    "cpfListStatus" "CpfListStatus" NOT NULL DEFAULT 'DISABLED',
    "cpfList" JSONB,
    "minQuantity" INTEGER,
    "ageRule" TEXT,
    "ageValue" TEXT,
    "status" "CouponStatus" NOT NULL DEFAULT 'ACTIVE',
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable (using IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS "TicketCategory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "eventId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable (using IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS "Ticket" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "eventId" UUID NOT NULL,
    "categoryId" UUID,
    "name" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "distance" TEXT,
    "distanceUnit" TEXT DEFAULT 'KM',
    "gender" TEXT,
    "ageLimitMin" INTEGER,
    "ageLimitMax" INTEGER,
    "hasKit" BOOLEAN NOT NULL DEFAULT false,
    "kitId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable (using IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS "TicketBatch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticketId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable (using IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS "Product" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "eventId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "image" TEXT,
    "isIncludedInTicket" BOOLEAN NOT NULL DEFAULT false,
    "basePrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable (using IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS "ProductVariation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "productId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariation_pkey" PRIMARY KEY ("id")
);

-- CreateTable (using IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS "TicketProduct" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticketId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable (using IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS "RegistrationTicket" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "registrationId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ModalityGroup_eventId_idx" ON "ModalityGroup"("eventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ModalityGroup_eventId_order_idx" ON "ModalityGroup"("eventId", "order");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Coupon_eventId_idx" ON "Coupon"("eventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Coupon_code_idx" ON "Coupon"("code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Coupon_status_idx" ON "Coupon"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Coupon_eventId_status_idx" ON "Coupon"("eventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Coupon_eventId_code_key" ON "Coupon"("eventId", "code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TicketCategory_eventId_idx" ON "TicketCategory"("eventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TicketCategory_eventId_order_idx" ON "TicketCategory"("eventId", "order");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Ticket_eventId_idx" ON "Ticket"("eventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Ticket_categoryId_idx" ON "Ticket"("categoryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Ticket_eventId_isActive_idx" ON "Ticket"("eventId", "isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TicketBatch_ticketId_idx" ON "TicketBatch"("ticketId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TicketBatch_ticketId_startDate_endDate_idx" ON "TicketBatch"("ticketId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Product_eventId_idx" ON "Product"("eventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductVariation_productId_idx" ON "ProductVariation"("productId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TicketProduct_ticketId_idx" ON "TicketProduct"("ticketId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TicketProduct_productId_idx" ON "TicketProduct"("productId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TicketProduct_ticketId_productId_key" ON "TicketProduct"("ticketId", "productId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RegistrationTicket_registrationId_idx" ON "RegistrationTicket"("registrationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RegistrationTicket_ticketId_idx" ON "RegistrationTicket"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RegistrationTicket_registrationId_ticketId_key" ON "RegistrationTicket"("registrationId", "ticketId");

-- CreateIndex (Event_slug_key already exists, skipping)
-- CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KitItem_productId_idx" ON "KitItem"("productId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Modality_groupId_idx" ON "Modality"("groupId");

-- CreateIndex (User_googleId_key already exists, skipping)
-- CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- AddForeignKey
ALTER TABLE "ModalityGroup" ADD CONSTRAINT "ModalityGroup_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Modality" ADD CONSTRAINT "Modality_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModalityGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitItem" ADD CONSTRAINT "KitItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketCategory" ADD CONSTRAINT "TicketCategory_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "TicketCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_kitId_fkey" FOREIGN KEY ("kitId") REFERENCES "Kit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketBatch" ADD CONSTRAINT "TicketBatch_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariation" ADD CONSTRAINT "ProductVariation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketProduct" ADD CONSTRAINT "TicketProduct_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketProduct" ADD CONSTRAINT "TicketProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationTicket" ADD CONSTRAINT "RegistrationTicket_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationTicket" ADD CONSTRAINT "RegistrationTicket_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
