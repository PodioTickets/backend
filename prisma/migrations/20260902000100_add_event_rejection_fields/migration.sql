-- Motivo da recusa do admin, exibido ao organizador na lista "Meus eventos".
-- Os campos NÃO são limpos quando o evento volta para DRAFT: servem de
-- histórico da última recusa e permitem reabrir o modal do motivo.
ALTER TABLE "Event" ADD COLUMN "rejection_reason" TEXT;
ALTER TABLE "Event" ADD COLUMN "rejected_at" TIMESTAMP(3);
ALTER TABLE "Event" ADD COLUMN "rejected_by_id" UUID;
