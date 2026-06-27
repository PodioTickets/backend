-- Reserva de uso de cupom (dimensão de CONTAGEM, espelha a reserva do voucher).
-- Enquanto um pedido PENDING detém o cupom, ele reserva N unidades (ingressos cobertos)
-- do `maxUsage`. A disponibilidade passa a ser maxUsage − usageCount − SUM(reservas ativas),
-- avaliada sob row-lock no claim — impede que pedidos concorrentes ultrapassem o limite.
-- Aditiva: coluna nullable + índice. Pedidos existentes ficam sem reserva (null = livre).
ALTER TABLE "Order" ADD COLUMN "couponReservedUnits" INTEGER;

-- Índice da SUM de reservas por cupom restrita a pedidos PENDING (claim/availability).
CREATE INDEX "Order_couponId_status_idx" ON "Order"("couponId", "status");
