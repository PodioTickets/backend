-- Taxa de estorno (refund) POR EVENTO.
--
-- CONTEXTO
--   A taxa de estorno (2%) era uma constante global hardcoded (`REFUND_FEE_RATE` em
--   common/utils/refund.util.ts), aplicada igual a TODOS os eventos — inclusive ao
--   recalcular estornos de eventos antigos. Não dava pra mudar a taxa "só pra frente".
--   A taxa de retenção (`retentionRate`) já era por evento; faltava paridade para o estorno.
--
-- O QUE ADICIONA
--   - refundFeeRate: fração (0.02 = 2%) cobrada do organizador no estorno/chargeback.
--     NOT NULL DEFAULT 0.02 → eventos EXISTENTES são backfillados com 0.02, preservando
--     EXATAMENTE o comportamento atual. Novos eventos snapshotam o default no create
--     (DEFAULT_REFUND_FEE_RATE no events.service); admin pode editar por evento antes do lock.
--     Estornos já realizados continuam usando o valor congelado em Payment.metadata.refundFee.
--
-- Float (Prisma) → DOUBLE PRECISION. Aditiva.

ALTER TABLE "Event" ADD COLUMN "refundFeeRate" DOUBLE PRECISION NOT NULL DEFAULT 0.02;
