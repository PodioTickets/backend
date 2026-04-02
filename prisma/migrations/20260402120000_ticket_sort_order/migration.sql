-- Ticket display order within (eventId, categoryId), including uncategorized (categoryId IS NULL).

ALTER TABLE "Ticket" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT
    id,
    (ROW_NUMBER() OVER (
      PARTITION BY "eventId", "categoryId"
      ORDER BY "createdAt" ASC
    ) - 1) AS rn
  FROM "Ticket"
)
UPDATE "Ticket" AS t
SET "sortOrder" = ranked.rn
FROM ranked
WHERE t.id = ranked.id;

CREATE INDEX "Ticket_eventId_categoryId_sortOrder_idx" ON "Ticket" ("eventId", "categoryId", "sortOrder");
