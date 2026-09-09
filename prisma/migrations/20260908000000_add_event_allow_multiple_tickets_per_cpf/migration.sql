-- Permitir mais de um ingresso por CPF, por evento.
-- Coluna NOT NULL com DEFAULT: o Postgres 11+ grava o default no catálogo em vez
-- de reescrever a tabela, então não trava a `Event` em produção.
-- Default false = comportamento novo (1 ingresso por documento no evento). Eventos
-- que já existem passam a valer a regra restritiva; inscrições JÁ criadas não são
-- tocadas — a validação só roda em pedidos novos.
ALTER TABLE "Event"
  ADD COLUMN "allowMultipleTicketsPerCpf" BOOLEAN NOT NULL DEFAULT false;
