-- Add social fields and contact email to Event
ALTER TABLE "public"."Event"
  ADD COLUMN "contact_email" TEXT,
  ADD COLUMN "instagram"     TEXT,
  ADD COLUMN "facebook"      TEXT,
  ADD COLUMN "youtube"       TEXT,
  ADD COLUMN "tiktok"        TEXT,
  ADD COLUMN "website"       TEXT;
