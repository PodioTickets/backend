-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "EventNotificationStatus" AS ENUM ('review', 'sent', 'denied');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "EventNotification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "eventId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "messageHtml" TEXT NOT NULL,
    "channels" TEXT[] NOT NULL,
    "status" "EventNotificationStatus" NOT NULL DEFAULT 'review',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventNotification_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EventNotification_eventId_fkey'
  ) THEN
    ALTER TABLE "EventNotification" ADD CONSTRAINT "EventNotification_eventId_fkey"
      FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EventNotification_createdById_fkey'
  ) THEN
    ALTER TABLE "EventNotification" ADD CONSTRAINT "EventNotification_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "EventNotification_eventId_occurredAt_idx" ON "EventNotification"("eventId", "occurredAt");
CREATE INDEX IF NOT EXISTS "EventNotification_eventId_status_occurredAt_idx" ON "EventNotification"("eventId", "status", "occurredAt");
