-- AlterEnum
-- Adiciona DEBIT_CARD ao enum PaymentMethod. O valor existe em `schema.prisma`
-- desde antes mas a migration correspondente nunca foi criada — bancos novos
-- (criados via `prisma migrate deploy`) ficaram sem DEBIT_CARD e quebravam ao
-- gravar pagamento de débito. `IF NOT EXISTS` deixa idempotente: bancos onde
-- o valor já foi adicionado manualmente (db push / SQL avulso) ignoram.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'DEBIT_CARD';
