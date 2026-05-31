-- Ordem de exibição por variação de produto. Gravada a partir do índice do array no create/update.
ALTER TABLE "ProductVariation" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Backfill determinístico das variações existentes: ordem por createdAt (e id como desempate)
-- dentro de cada produto, começando em 0. Preserva uma ordem estável para o histórico.
WITH ordered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY "productId" ORDER BY "createdAt" ASC, "id" ASC) - 1 AS rn
  FROM "ProductVariation"
)
UPDATE "ProductVariation" pv
SET "sortOrder" = o.rn
FROM ordered o
WHERE pv.id = o.id;
