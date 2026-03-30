-- AlterTable
ALTER TABLE "TicketProduct" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Backfill: preserve stable order by creation time within each ticket
WITH ranked AS (
  SELECT id, (ROW_NUMBER() OVER (PARTITION BY "ticketId" ORDER BY "createdAt" ASC) - 1)::integer AS rn
  FROM "TicketProduct"
)
UPDATE "TicketProduct" AS tp
SET "sortOrder" = ranked.rn
FROM ranked
WHERE tp.id = ranked.id;

-- CreateIndex
CREATE INDEX "TicketProduct_ticketId_sortOrder_idx" ON "TicketProduct"("ticketId", "sortOrder");
