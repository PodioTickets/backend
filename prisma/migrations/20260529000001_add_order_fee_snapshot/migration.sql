-- Snapshot dos percentuais de taxa no pedido, congelados no instante do pagamento.
--
-- CONTEXTO
--   `Order.serviceFee` (valor em centavos) já era um snapshot do que foi cobrado, mas o
--   PERCENTUAL que o gerou não era guardado, e o `organizerFeePercent` (taxa Podio↔organizador)
--   só existia no Evento — lido AO VIVO pelo repasse/financeiro. Se o organizador altera a
--   config depois, pedidos antigos passam a ser recalculados com a alíquota nova (distorção).
--
-- O QUE ADICIONA
--   - participantFeePercent: alíquota da taxa de serviço (participante) no pagamento.
--   - organizerFeePercent:   alíquota da taxa do organizador no pagamento.
--   Ambas NULLABLE: pedidos legados ficam NULL e os consumidores caem no valor vivo do evento
--   (fallback), preservando o comportamento atual. Pedidos novos passam a gravar o snapshot
--   no `pay` (PIX / cartão / débito 3DS).
--
-- Float (Prisma) → DOUBLE PRECISION. Aditiva e idempotente o suficiente (ADD COLUMN); sem backfill
-- (não dá pra reconstruir a alíquota histórica com segurança — o fallback ao vivo cobre o legado).

ALTER TABLE "Order" ADD COLUMN "participantFeePercent" DOUBLE PRECISION;
ALTER TABLE "Order" ADD COLUMN "organizerFeePercent" DOUBLE PRECISION;
