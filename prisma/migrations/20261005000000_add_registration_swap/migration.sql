-- Troca de ingresso pelo admin: a inscrição antiga é ANULADA (status CANCELLED + voidedAt)
-- e substituída por uma nova (replacedById). Colunas nullable sem default — ADD COLUMN só
-- altera o catálogo; inscrições existentes ficam NULL (= nunca trocadas).
ALTER TABLE "Registration" ADD COLUMN "voidedAt" TIMESTAMP(3);
ALTER TABLE "Registration" ADD COLUMN "replacedById" UUID;

CREATE UNIQUE INDEX "Registration_replacedById_key" ON "Registration"("replacedById");

ALTER TABLE "Registration" ADD CONSTRAINT "Registration_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
