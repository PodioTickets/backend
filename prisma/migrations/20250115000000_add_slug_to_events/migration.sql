-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "slug" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug") WHERE "slug" IS NOT NULL;

-- CreateIndex
CREATE INDEX "Event_slug_idx" ON "Event"("slug");

