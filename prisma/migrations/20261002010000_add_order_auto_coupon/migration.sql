-- Acúmulo de cupom automático (AGE/QUANTITY) com cupom manual: segunda posição de cupom
-- no pedido. Colunas nullable sem default — ADD COLUMN só altera o catálogo. Pedidos
-- existentes ficam com NULL (= cupom único, comportamento atual).
ALTER TABLE "Order" ADD COLUMN "autoCouponId" UUID;
ALTER TABLE "Order" ADD COLUMN "autoCouponReservedUnits" INTEGER;
ALTER TABLE "Order" ADD COLUMN "autoDiscount" INTEGER;

CREATE INDEX "Order_autoCouponId_status_idx" ON "Order"("autoCouponId", "status");

ALTER TABLE "Order" ADD CONSTRAINT "Order_autoCouponId_fkey" FOREIGN KEY ("autoCouponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;
