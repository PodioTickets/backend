-- AlterTable
-- Campos de endereço completos no perfil do usuário (espelhados do endereço
-- de cobrança do pedido em PATCH /orders/:id/billing-address). Todos nullable
-- e aditivos: nenhum dado histórico é afetado e nenhum backfill é necessário.
ALTER TABLE "User"
  ADD COLUMN "postalCode"   TEXT,
  ADD COLUMN "street"       TEXT,
  ADD COLUMN "number"       TEXT,
  ADD COLUMN "complement"   TEXT,
  ADD COLUMN "neighborhood" TEXT;
