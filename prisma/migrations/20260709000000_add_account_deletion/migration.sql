-- Exclusão de conta pelo próprio usuário (soft-delete + anonimização).
--
-- "User"."deletedAt": marcador dedicado de conta excluída. NÃO reusa "isActive"
-- porque o resetPassword reativa isActive — um usuário excluído poderia "renascer"
-- via recuperação de senha. Login/refresh/reset passam a rejeitar quando setado.
--
-- "Order"."buyerSnapshot": congela a identidade do COMPRADOR no instante da
-- exclusão, para o organizador continuar enxergando quem pagou depois que os
-- dados vivos do usuário forem anonimizados. NULL = comprador ainda ativo.
-- Ambas nullable, sem default: linhas existentes ficam NULL (comportamento atual).
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "buyerSnapshot" JSONB;
