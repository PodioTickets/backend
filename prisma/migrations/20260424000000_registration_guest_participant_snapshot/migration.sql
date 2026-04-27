-- Make userId nullable (participant may not have an account)
ALTER TABLE "Registration" ALTER COLUMN "userId" DROP NOT NULL;

-- Add guest participant snapshot fields
ALTER TABLE "Registration"
  ADD COLUMN "participantName"        TEXT,
  ADD COLUMN "participantEmail"       TEXT,
  ADD COLUMN "participantCpf"         TEXT,
  ADD COLUMN "participantCpfClean"    TEXT,
  ADD COLUMN "participantPhone"       TEXT,
  ADD COLUMN "participantDateOfBirth" TIMESTAMP(3),
  ADD COLUMN "participantGender"      TEXT;

-- Index for CPF-based participant lookup
CREATE INDEX "Registration_participantCpfClean_idx" ON "Registration"("participantCpfClean");

-- Update FK to SET NULL instead of CASCADE (userId is now optional)
ALTER TABLE "Registration" DROP CONSTRAINT "Registration_userId_fkey";
ALTER TABLE "Registration"
  ADD CONSTRAINT "Registration_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
