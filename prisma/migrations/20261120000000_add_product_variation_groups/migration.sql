-- Kit com várias variações (20/11/2026): cada Product tem 0..N variações (grupos/perguntas,
-- ex.: "Tamanho da camisa", "Tamanho do short"), cada uma com 1..N opções (ProductVariation).
-- "Sem interesse" segue como ProductVariation do produto SEM grupo (groupId = null).
-- RegistrationProduct.variationIds guarda TODAS as opções escolhidas (variationId = a 1ª, legado).

-- CreateTable
CREATE TABLE "ProductVariationGroup" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "productId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariationGroup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductVariationGroup_productId_idx" ON "ProductVariationGroup"("productId");

ALTER TABLE "ProductVariationGroup" ADD CONSTRAINT "ProductVariationGroup_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ProductVariation.groupId (nullable: sem rewrite da tabela)
ALTER TABLE "ProductVariation" ADD COLUMN "groupId" UUID;

CREATE INDEX "ProductVariation_groupId_idx" ON "ProductVariation"("groupId");

ALTER TABLE "ProductVariation" ADD CONSTRAINT "ProductVariation_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ProductVariationGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RegistrationProduct.variationIds (default constante: Postgres 11+ não reescreve a tabela)
ALTER TABLE "RegistrationProduct" ADD COLUMN "variationIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

-- Backfill 1: um grupo por produto que tenha alguma opção além de "Sem interesse".
-- Nome do grupo = variationType legado (ou "Variação" quando vazio); todas as opções
-- não-"Sem interesse" passam a apontar para ele.
WITH g AS (
  INSERT INTO "ProductVariationGroup" ("productId", "name", "sortOrder", "updatedAt")
  SELECT p."id", COALESCE(NULLIF(TRIM(p."variationType"), ''), 'Variação'), 0, CURRENT_TIMESTAMP
  FROM "Product" p
  WHERE EXISTS (
    SELECT 1 FROM "ProductVariation" v
    WHERE v."productId" = p."id" AND LOWER(TRIM(v."name")) <> 'sem interesse'
  )
  RETURNING "id", "productId", "name"
),
upd_variations AS (
  UPDATE "ProductVariation" v
  SET "groupId" = g."id"
  FROM g
  WHERE v."productId" = g."productId" AND LOWER(TRIM(v."name")) <> 'sem interesse'
  RETURNING v."id"
)
-- Legado: Product.variationType = nome do 1º grupo.
UPDATE "Product" p
SET "variationType" = g."name"
FROM g
WHERE p."id" = g."productId";

-- Backfill 2: escolhas antigas (1 opção) viram a lista de 1 elemento.
UPDATE "RegistrationProduct"
SET "variationIds" = ARRAY["variationId"]
WHERE "variationId" IS NOT NULL;

-- Kit × produto avulso (23/11/2026). Até aqui todo produto existia só como conteúdo do kit de
-- um ingresso (o vínculo exigia hasKit) → os existentes viram kit; novos nascem avulsos.
ALTER TABLE "Product" ADD COLUMN "isKit" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Product" SET "isKit" = true;
-- Vínculos órfãos (ingresso SEM kit com produto): nunca foram exibidos (gate do front/back).
-- Apagar antes de o ingresso sem kit passar a exibir produtos avulsos.
DELETE FROM "TicketProduct" tp USING "Ticket" t WHERE tp."ticketId" = t."id" AND t."hasKit" = false;
