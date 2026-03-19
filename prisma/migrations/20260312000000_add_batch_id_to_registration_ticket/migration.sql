-- AlterTable
ALTER TABLE "RegistrationTicket" ADD COLUMN IF NOT EXISTS "batchId" UUID;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RegistrationTicket_batchId_idx" ON "RegistrationTicket"("batchId");

-- AddForeignKey
ALTER TABLE "RegistrationTicket" ADD CONSTRAINT "RegistrationTicket_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "TicketBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
