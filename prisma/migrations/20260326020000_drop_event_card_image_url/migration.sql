-- Remove coluna caso a migration anterior tenha sido aplicada (cardImageUrl → usar logoUrl).
ALTER TABLE "Event" DROP COLUMN IF EXISTS "cardImageUrl";
