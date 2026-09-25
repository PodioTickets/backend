-- Excluir um User apagava em cascata os pedidos dele (Order → Registration →
-- ingressos/produtos/respostas; Payment). A inscrição de cortesia do painel grava o
-- COLABORADOR como dono do pedido, então remover o colaborador da equipe fazia as
-- inscrições que ele criou sumirem. O fluxo de remoção passou a fazer soft-delete de
-- conta com histórico (remove-user-account.util.ts); RESTRICT é a segunda camada —
-- qualquer hard-delete futuro de conta com pedido falha em vez de apagar.
--
-- NOT VALID + VALIDATE: o ADD CONSTRAINT só pega lock breve; a varredura das linhas
-- existentes roda no VALIDATE, que não bloqueia escrita em "Order"/"Payment".
ALTER TABLE "Order" DROP CONSTRAINT "Order_userId_fkey";
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_userId_fkey";

ALTER TABLE "Payment" DROP CONSTRAINT "Payment_userId_fkey";
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Payment" VALIDATE CONSTRAINT "Payment_userId_fkey";
