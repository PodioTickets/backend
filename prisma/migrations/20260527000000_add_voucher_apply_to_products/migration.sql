-- Voucher.applyToProducts: espelha Coupon.applyToProducts. Quando true, o ingresso
-- grátis do voucher cobre TAMBÉM os produtos adicionais (kits/extras) do pedido,
-- somando o subtotal de produtos ao desconto.
--
-- Sem backfill: vouchers existentes nunca cobriram produtos (sempre = 1 ingresso
-- grátis), então o default false preserva exatamente o comportamento histórico.
ALTER TABLE "Voucher"
  ADD COLUMN "applyToProducts" BOOLEAN NOT NULL DEFAULT false;
