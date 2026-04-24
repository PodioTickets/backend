-- AlterTable: adicionar campos de contato de emergência na Registration
ALTER TABLE "Registration"
  ADD COLUMN IF NOT EXISTS "emergencyContactName"  TEXT,
  ADD COLUMN IF NOT EXISTS "emergencyContactPhone" TEXT;

-- AlterTable: adicionar chave de idempotência no Order
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

-- Índice único para garantir idempotência (apenas para valores não nulos)
CREATE UNIQUE INDEX IF NOT EXISTS "Order_idempotencyKey_key"
  ON "Order"("idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
