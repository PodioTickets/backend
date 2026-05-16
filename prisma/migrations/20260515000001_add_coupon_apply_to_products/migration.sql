-- Coupon.applyToProducts: quando true, o desconto também incide sobre os produtos
-- adicionais (kits/extras) do pedido — não apenas sobre o preço base dos ingressos.
ALTER TABLE "Coupon"
  ADD COLUMN "applyToProducts" BOOLEAN NOT NULL DEFAULT false;

-- Backfill de retrocompatibilidade: cupons QUANTITY existentes hoje já incluem
-- produtos na base (tanto PERCENTAGE quanto FIXED via cap em preDiscountTotal),
-- então marcamos o flag pra que o comportamento permaneça igual após a refatoração.
-- Cupons DISCOUNT e AGE existentes nunca incluíram produtos → permanecem com false.
UPDATE "Coupon" SET "applyToProducts" = true WHERE "couponType" = 'QUANTITY';
