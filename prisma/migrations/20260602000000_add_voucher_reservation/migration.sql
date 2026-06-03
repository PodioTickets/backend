-- Reserva de uso único do voucher: enquanto um pedido PENDING detém o voucher, ele fica
-- "claimed". Impede aplicar o MESMO voucher a dois pedidos ao mesmo tempo (double-use).
-- Aditiva: colunas nullable + índice. Não altera vouchers existentes (todos ficam "livres").
ALTER TABLE "Voucher" ADD COLUMN "reservedByOrderId" UUID;
ALTER TABLE "Voucher" ADD COLUMN "reservedUntil" TIMESTAMP(3);

CREATE INDEX "Voucher_reservedByOrderId_idx" ON "Voucher"("reservedByOrderId");
