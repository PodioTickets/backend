-- LinkedUser: migrate from FK-based linking to standalone participant profiles
-- Drops the relation to a second User account and stores participant data directly.

DROP TABLE IF EXISTS "LinkedUser";

CREATE TABLE "LinkedUser" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "mainUserId"          UUID         NOT NULL,
  "firstName"           TEXT         NOT NULL,
  "lastName"            TEXT         NOT NULL,
  "email"               TEXT,
  "documentNumber"      TEXT,
  "documentNumberClean" TEXT,
  "phone"               TEXT,
  "dateOfBirth"         TIMESTAMP(3),
  "gender"              TEXT,
  "relationshipType"    TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LinkedUser_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LinkedUser"
  ADD CONSTRAINT "LinkedUser_mainUserId_fkey"
  FOREIGN KEY ("mainUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "LinkedUser_mainUserId_documentNumberClean_key"
  ON "LinkedUser"("mainUserId", "documentNumberClean");

CREATE INDEX "LinkedUser_mainUserId_idx" ON "LinkedUser"("mainUserId");
