-- RenameTicketCategoryOrderToSortOrder
DROP INDEX IF EXISTS "TicketCategory_eventId_order_idx";
ALTER TABLE "TicketCategory" RENAME COLUMN "order" TO "sortOrder";
CREATE INDEX "TicketCategory_eventId_sortOrder_idx" ON "TicketCategory"("eventId", "sortOrder");
