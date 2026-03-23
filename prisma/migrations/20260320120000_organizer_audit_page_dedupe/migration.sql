-- Dedup de page views no audit (evita spam em F5); ver OrganizationsService.recordOrganizerPageView
CREATE TABLE IF NOT EXISTS "OrganizerAuditPageDedupe" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "pageKey" TEXT NOT NULL,
    "lastRecordedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizerAuditPageDedupe_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrganizerAuditPageDedupe_organizationId_actorUserId_pageKey_key"
  ON "OrganizerAuditPageDedupe"("organizationId", "actorUserId", "pageKey");

CREATE INDEX IF NOT EXISTS "OrganizerAuditPageDedupe_organizationId_lastRecordedAt_idx"
  ON "OrganizerAuditPageDedupe"("organizationId", "lastRecordedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OrganizerAuditPageDedupe_organizationId_fkey'
  ) THEN
    ALTER TABLE "OrganizerAuditPageDedupe" ADD CONSTRAINT "OrganizerAuditPageDedupe_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OrganizerAuditPageDedupe_actorUserId_fkey'
  ) THEN
    ALTER TABLE "OrganizerAuditPageDedupe" ADD CONSTRAINT "OrganizerAuditPageDedupe_actorUserId_fkey"
      FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
