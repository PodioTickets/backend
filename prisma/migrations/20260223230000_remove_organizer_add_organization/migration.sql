-- CreateEnum
CREATE TYPE "OrganizationMemberRole" AS ENUM ('OWNER', 'EMPLOYEE');

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "OrganizationMemberRole" NOT NULL DEFAULT 'EMPLOYEE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Organization_name_idx" ON "Organization"("name");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "OrganizationMember_organizationId_idx" ON "OrganizationMember"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationMember_userId_idx" ON "OrganizationMember"("userId");

-- CreateIndex
CREATE INDEX "OrganizationMember_organizationId_role_idx" ON "OrganizationMember"("organizationId", "role");

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: Add organizationId to Event
ALTER TABLE "Event" ADD COLUMN "organizationId" UUID;

-- Migrate data: Copy organizerId to organizationId
-- First, create organizations from organizers
INSERT INTO "Organization" ("id", "name", "email", "phone", "description", "createdAt", "updatedAt")
SELECT "id", "name", "email", "phone", "description", "createdAt", "updatedAt"
FROM "Organizer";

-- Create organization members (owners)
INSERT INTO "OrganizationMember" ("id", "organizationId", "userId", "role", "createdAt", "updatedAt")
SELECT gen_random_uuid(), "id", "userId", 'OWNER', "createdAt", "updatedAt"
FROM "Organizer";

-- Update Event.organizationId from Event.organizerId
UPDATE "Event" SET "organizationId" = "organizerId";

-- Make organizationId NOT NULL
ALTER TABLE "Event" ALTER COLUMN "organizationId" SET NOT NULL;

-- AddForeignKey for Event
ALTER TABLE "Event" ADD CONSTRAINT "Event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Update ContactMessage
ALTER TABLE "ContactMessage" ADD COLUMN "organizationId" UUID;
UPDATE "ContactMessage" SET "organizationId" = "organizerId";
ALTER TABLE "ContactMessage" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "ContactMessage" ADD CONSTRAINT "ContactMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Drop old indexes and foreign keys
ALTER TABLE "Event" DROP CONSTRAINT IF EXISTS "Event_organizerId_fkey";
ALTER TABLE "Event" DROP COLUMN "organizerId";
DROP INDEX IF EXISTS "Event_organizerId_createdAt_idx";
CREATE INDEX "Event_organizationId_createdAt_idx" ON "Event"("organizationId", "createdAt");

ALTER TABLE "ContactMessage" DROP CONSTRAINT IF EXISTS "ContactMessage_organizerId_fkey";
ALTER TABLE "ContactMessage" DROP COLUMN "organizerId";
DROP INDEX IF EXISTS "ContactMessage_organizerId_idx";
CREATE INDEX "ContactMessage_organizationId_idx" ON "ContactMessage"("organizationId");

-- Drop Organizer table
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_organizerId_fkey";
ALTER TABLE "User" DROP COLUMN IF EXISTS "organizerId";
DROP TABLE IF EXISTS "Organizer";
