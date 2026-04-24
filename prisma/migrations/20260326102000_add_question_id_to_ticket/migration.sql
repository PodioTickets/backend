-- Permite vincular uma pergunta a varios tickets via "appliesTo".
-- Formato: 'all' ou JSON array de ticket IDs.
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "appliesTo" TEXT;
