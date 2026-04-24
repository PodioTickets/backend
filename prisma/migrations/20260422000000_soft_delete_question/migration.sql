-- AlterTable
ALTER TABLE "Question" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Question" ADD COLUMN "description" TEXT;

-- CreateIndex
CREATE INDEX "Question_eventId_isActive_idx" ON "Question"("eventId", "isActive");
