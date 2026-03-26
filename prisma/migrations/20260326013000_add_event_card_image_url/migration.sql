-- Adiciona coluna temporaria para imagem do card do evento.
-- Esta coluna e removida na migration seguinte (20260326020000_drop_event_card_image_url).
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "cardImageUrl" TEXT;
