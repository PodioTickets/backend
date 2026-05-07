-- AlterTable Organization: active/inactive status for admin management
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Organization_isActive_idx" ON "Organization"("isActive");
