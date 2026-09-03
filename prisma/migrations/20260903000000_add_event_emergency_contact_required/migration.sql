-- Contato de emergência obrigatório por evento.
-- Coluna NOT NULL com DEFAULT: o Postgres 11+ grava o default no catálogo em vez
-- de reescrever a tabela, então não trava a `Event` em produção.
ALTER TABLE "Event"
  ADD COLUMN "emergencyContactRequired" BOOLEAN NOT NULL DEFAULT false;
