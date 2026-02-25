-- AlterTable: Add new fields to Organization
ALTER TABLE "Organization" ADD COLUMN "tradeName" TEXT;
ALTER TABLE "Organization" ADD COLUMN "document" TEXT;
ALTER TABLE "Organization" ADD COLUMN "logoUrl" TEXT;
ALTER TABLE "Organization" ADD COLUMN "whatsapp" TEXT;
ALTER TABLE "Organization" ADD COLUMN "siteUrl" TEXT;
ALTER TABLE "Organization" ADD COLUMN "instagram" TEXT;
ALTER TABLE "Organization" ADD COLUMN "zipCode" TEXT;
ALTER TABLE "Organization" ADD COLUMN "street" TEXT;
ALTER TABLE "Organization" ADD COLUMN "number" TEXT;
ALTER TABLE "Organization" ADD COLUMN "neighborhood" TEXT;
ALTER TABLE "Organization" ADD COLUMN "city" TEXT;
ALTER TABLE "Organization" ADD COLUMN "state" TEXT;
ALTER TABLE "Organization" ADD COLUMN "ownerName" TEXT;
ALTER TABLE "Organization" ADD COLUMN "pix" TEXT;
ALTER TABLE "Organization" ADD COLUMN "bankName" TEXT;
ALTER TABLE "Organization" ADD COLUMN "bankCode" TEXT;
ALTER TABLE "Organization" ADD COLUMN "agency" TEXT;
ALTER TABLE "Organization" ADD COLUMN "account" TEXT;
ALTER TABLE "Organization" ADD COLUMN "accountType" TEXT;
ALTER TABLE "Organization" ADD COLUMN "accountHolderName" TEXT;
ALTER TABLE "Organization" ADD COLUMN "accountHolderDocument" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_document_key" ON "Organization"("document");
CREATE INDEX "Organization_document_idx" ON "Organization"("document");
CREATE INDEX "Organization_email_idx" ON "Organization"("email");
