-- Add sortOrder and triggerType to TicketBatch
ALTER TABLE "TicketBatch" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TicketBatch" ADD COLUMN "triggerType" TEXT NOT NULL DEFAULT 'BY_TIME';

-- Backfill sortOrder: assign sequential order per ticket based on creation date
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "ticketId" ORDER BY "createdAt") - 1 AS rn
  FROM "TicketBatch"
)
UPDATE "TicketBatch" b SET "sortOrder" = r.rn FROM ranked r WHERE b.id = r.id;

-- Indexes
CREATE INDEX "TicketBatch_ticketId_sortOrder_idx" ON "TicketBatch"("ticketId", "sortOrder");
