-- OrderStatus enum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

-- Add fields to Order
ALTER TABLE "Order" ADD COLUMN "status" "OrderStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Order" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "reservedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "cancelledReason" TEXT;
ALTER TABLE "Order" ADD COLUMN "pendingParticipants" JSONB;
ALTER TABLE "Order" ADD COLUMN "pendingProducts" JSONB;

-- Index for expiration cron scan
CREATE INDEX "Order_status_expiresAt_idx" ON "Order"("status", "expiresAt");

-- Add availableQuantity to TicketBatch (populate from existing sold counts)
ALTER TABLE "TicketBatch" ADD COLUMN "availableQuantity" INTEGER;
UPDATE "TicketBatch" tb
SET "availableQuantity" = tb.quantity - COALESCE((
  SELECT COUNT(*)
  FROM "RegistrationTicket" rt
  JOIN "Registration" r ON r.id = rt."registrationId"
  WHERE rt."batchId" = tb.id
  AND r.status != 'CANCELLED'
), 0);
ALTER TABLE "TicketBatch" ALTER COLUMN "availableQuantity" SET NOT NULL;

-- OrderReservedTicket
CREATE TABLE "OrderReservedTicket" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "ticketId" UUID NOT NULL,
  "batchId" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unitPrice" INTEGER NOT NULL,
  "batchName" TEXT,
  "ticketName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderReservedTicket_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "OrderReservedTicket" ADD CONSTRAINT "OrderReservedTicket_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderReservedTicket" ADD CONSTRAINT "OrderReservedTicket_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderReservedTicket" ADD CONSTRAINT "OrderReservedTicket_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "TicketBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "OrderReservedTicket_orderId_idx" ON "OrderReservedTicket"("orderId");
CREATE INDEX "OrderReservedTicket_ticketId_idx" ON "OrderReservedTicket"("ticketId");
CREATE INDEX "OrderReservedTicket_batchId_idx" ON "OrderReservedTicket"("batchId");
