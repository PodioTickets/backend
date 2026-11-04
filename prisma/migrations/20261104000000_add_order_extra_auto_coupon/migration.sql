-- Cupons automáticos sem ingresso em comum valem juntos no pedido: os além do principal
-- ficam nesta tabela. Só cria tabela nova (sem tocar nem travar "Order"/"Coupon" além das FKs
-- de uma tabela vazia); pedidos existentes seguem iguais, sem linha aqui.
CREATE TABLE "OrderExtraAutoCoupon" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orderId" UUID NOT NULL,
    "couponId" UUID NOT NULL,
    "discount" INTEGER NOT NULL,
    "reservedUnits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderExtraAutoCoupon_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderExtraAutoCoupon_orderId_couponId_key" ON "OrderExtraAutoCoupon"("orderId", "couponId");
CREATE INDEX "OrderExtraAutoCoupon_couponId_idx" ON "OrderExtraAutoCoupon"("couponId");

ALTER TABLE "OrderExtraAutoCoupon" ADD CONSTRAINT "OrderExtraAutoCoupon_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderExtraAutoCoupon" ADD CONSTRAINT "OrderExtraAutoCoupon_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
