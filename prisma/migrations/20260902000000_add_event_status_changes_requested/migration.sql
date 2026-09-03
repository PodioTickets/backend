-- AlterEnum: novo status entre REVISION e PUBLISHED.
-- O admin recusa um evento em revisão e ele volta para o organizador como
-- "Ajustes solicitados" — estado do qual se sai voltando para DRAFT.
--
-- Em migration própria de propósito: no Postgres um valor recém-adicionado a um
-- enum não pode ser REFERENCIADO na mesma transação que o adicionou. Separar do
-- ALTER TABLE seguinte evita esse conflito em qualquer versão do servidor.
ALTER TYPE "EventStatus" ADD VALUE IF NOT EXISTS 'CHANGES_REQUESTED';
