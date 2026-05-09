-- Migra valores legados do `organizerFeeRate` (escala 0-1, ex.: 0.04 = 4%) para
-- `organizerFeePercent` (escala 0-100, ex.: 4 = 4%) apenas onde ainda não foi
-- configurado pelo organizador (organizerFeePercent = 0). Preserva valores já
-- ajustados explicitamente.
UPDATE "Event"
SET "organizerFeePercent" = ROUND(("organizerFeeRate" * 100)::numeric, 2)::double precision
WHERE "organizerFeePercent" = 0
  AND "organizerFeeRate" IS NOT NULL
  AND "organizerFeeRate" > 0;

-- Remove a coluna legada — agora `organizerFeePercent` é a única fonte da verdade.
ALTER TABLE "Event" DROP COLUMN "organizerFeeRate";
