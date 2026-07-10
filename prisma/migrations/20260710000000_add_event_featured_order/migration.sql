-- Eventos em destaque (carrossel da home + prioridade na busca pública).
-- NULL = evento NÃO está em destaque (comportamento histórico de todos os
-- eventos existentes). Valor menor aparece primeiro. Índice para o carrossel e
-- para a ordenação "destaque primeiro" (nulls last) na busca.
ALTER TABLE "Event" ADD COLUMN "featured_order" INTEGER;

CREATE INDEX "Event_featured_order_idx" ON "Event"("featured_order");
