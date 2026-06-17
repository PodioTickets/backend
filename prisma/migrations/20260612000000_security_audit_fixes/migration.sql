-- Correções da auditoria de segurança (2026-06-12)

-- 1. EventWithdrawal.requestedById: Cascade -> Restrict.
--    Deletar o User que solicitou o saque apagava o histórico de EventWithdrawal
--    em cascata; o saldo do repasse (saldoDisponivel - totalWithdrawn) "recuperava"
--    o valor já pago e permitia sacar o mesmo dinheiro duas vezes.
ALTER TABLE "EventWithdrawal" DROP CONSTRAINT "EventWithdrawal_requestedById_fkey";
ALTER TABLE "EventWithdrawal"
  ADD CONSTRAINT "EventWithdrawal_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. User.passwordChangedAt: marca a última troca de senha. O JwtStrategy rejeita
--    tokens com iat anterior a este timestamp — troca/reset de senha passa a
--    derrubar sessões/tokens roubados (antes ficavam válidos por até 30 dias).
ALTER TABLE "User" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
