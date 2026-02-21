-- Add regulationUrl column to Event table
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "regulationUrl" TEXT;
