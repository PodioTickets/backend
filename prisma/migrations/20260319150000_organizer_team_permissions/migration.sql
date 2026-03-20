-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrganizationMember" ADD COLUMN IF NOT EXISTS "permissions" JSONB;

-- CreateTable
CREATE TABLE IF NOT EXISTS "OrganizationMemberEventAccess" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationMemberId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationMemberEventAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "OrganizationAuditLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "actorUserId" UUID,
    "ip" TEXT,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrganizationMemberEventAccess_organizationMemberId_eventId_key" ON "OrganizationMemberEventAccess"("organizationMemberId", "eventId");
CREATE INDEX IF NOT EXISTS "OrganizationMemberEventAccess_organizationMemberId_idx" ON "OrganizationMemberEventAccess"("organizationMemberId");
CREATE INDEX IF NOT EXISTS "OrganizationMemberEventAccess_eventId_idx" ON "OrganizationMemberEventAccess"("eventId");

CREATE INDEX IF NOT EXISTS "OrganizationAuditLog_organizationId_occurredAt_idx" ON "OrganizationAuditLog"("organizationId", "occurredAt");
CREATE INDEX IF NOT EXISTS "OrganizationAuditLog_organizationId_action_idx" ON "OrganizationAuditLog"("organizationId", "action");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OrganizationMemberEventAccess_organizationMemberId_fkey'
  ) THEN
    ALTER TABLE "OrganizationMemberEventAccess" ADD CONSTRAINT "OrganizationMemberEventAccess_organizationMemberId_fkey" FOREIGN KEY ("organizationMemberId") REFERENCES "OrganizationMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OrganizationMemberEventAccess_eventId_fkey'
  ) THEN
    ALTER TABLE "OrganizationMemberEventAccess" ADD CONSTRAINT "OrganizationMemberEventAccess_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OrganizationAuditLog_organizationId_fkey'
  ) THEN
    ALTER TABLE "OrganizationAuditLog" ADD CONSTRAINT "OrganizationAuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OrganizationAuditLog_actorUserId_fkey'
  ) THEN
    ALTER TABLE "OrganizationAuditLog" ADD CONSTRAINT "OrganizationAuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
