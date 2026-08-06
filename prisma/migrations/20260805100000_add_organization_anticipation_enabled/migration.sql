-- Antecipação de recebíveis habilitada por organização. DESLIGADA por padrão —
-- o admin ativa manualmente no drawer da organização.
ALTER TABLE "Organization" ADD COLUMN "anticipationEnabled" BOOLEAN NOT NULL DEFAULT false;
