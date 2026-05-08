-- Adiciona percentual de taxa do participante como campo independente
ALTER TABLE "Event"
  ADD COLUMN IF NOT EXISTS "participantFeePercent" FLOAT NOT NULL DEFAULT 0.0;
