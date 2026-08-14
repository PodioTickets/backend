-- Cortesia (inscrição manual do organizador, sem pagamento): pedido R$0
-- finalizado direto como PAID. Distingue cortesias de vendas reais.
ALTER TABLE "Order" ADD COLUMN "isCourtesy" BOOLEAN NOT NULL DEFAULT false;
