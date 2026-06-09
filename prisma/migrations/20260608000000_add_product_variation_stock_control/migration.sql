-- Controle de estoque + contagem de vendas por variação de produto.
-- `stock` continua sendo o LIMITE configurado (0 = ilimitado).
-- `availableStock` = restante (decrementado no hold, restaurado no release).
-- `soldCount` = unidades vendidas (confirmadas no pay, revertidas no estorno).
ALTER TABLE "ProductVariation" ADD COLUMN "availableStock" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ProductVariation" ADD COLUMN "soldCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill: histórico ainda não consumiu estoque → availableStock parte igual ao limite.
-- (Para stock = 0 / ilimitado o campo é ignorado pelo guard `stock > 0`.)
UPDATE "ProductVariation" SET "availableStock" = "stock";
