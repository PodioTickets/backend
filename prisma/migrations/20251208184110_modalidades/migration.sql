/*
  Warnings:

  - You are about to drop the column `groupId` on the `Modality` table. All the data in the column will be lost.
  - You are about to drop the `ModalityGroup` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."Modality" DROP CONSTRAINT "Modality_groupId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ModalityGroup" DROP CONSTRAINT "ModalityGroup_eventId_fkey";

-- DropIndex
DROP INDEX "public"."Modality_groupId_idx";

-- AlterTable
ALTER TABLE "Modality" DROP COLUMN "groupId",
ADD COLUMN     "templateId" UUID;

-- DropTable
DROP TABLE "public"."ModalityGroup";

-- CreateTable
CREATE TABLE "ModalityTemplate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "icon" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModalityTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModalityTemplate_code_key" ON "ModalityTemplate"("code");

-- CreateIndex
CREATE INDEX "ModalityTemplate_code_idx" ON "ModalityTemplate"("code");

-- CreateIndex
CREATE INDEX "ModalityTemplate_isActive_idx" ON "ModalityTemplate"("isActive");

-- CreateIndex
CREATE INDEX "Modality_templateId_idx" ON "Modality"("templateId");

-- CreateIndex
CREATE INDEX "Modality_eventId_isActive_idx" ON "Modality"("eventId", "isActive");

-- AddForeignKey
ALTER TABLE "Modality" ADD CONSTRAINT "Modality_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ModalityTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
