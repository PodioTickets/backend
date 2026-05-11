-- Adiciona referência + snapshot da chave PIX selecionada no momento do saque.
-- pixKeyId é nullable + ON DELETE SET NULL para preservar histórico em caso de
-- remoção da OrganizationPixKey. O snapshot (pixKeySnapshot) é a fonte de
-- verdade para o admin executar o repasse: nunca confiar na chave atual, que
-- pode ter sido editada após a solicitação.
ALTER TABLE "EventWithdrawal"
  ADD COLUMN IF NOT EXISTS "pixKeyId" UUID,
  ADD COLUMN IF NOT EXISTS "pixKeySnapshot" JSONB;

CREATE INDEX IF NOT EXISTS "EventWithdrawal_pixKeyId_idx"
  ON "EventWithdrawal" ("pixKeyId");

ALTER TABLE "EventWithdrawal"
  ADD CONSTRAINT "EventWithdrawal_pixKeyId_fkey"
  FOREIGN KEY ("pixKeyId") REFERENCES "OrganizationPixKey"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
