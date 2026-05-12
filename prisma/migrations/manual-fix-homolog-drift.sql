-- =============================================================================
-- Fix manual de drift entre banco e schema.prisma (homologação)
-- Data: 2026-05-12
-- Contexto: _prisma_migrations diz que está em dia, mas o estado físico do
-- banco corresponde a um ponto anterior. Resultado de restore de dump antigo
-- mantendo a tabela _prisma_migrations populada.
--
-- IMPORTANTE: rodar os SELECTs de validação ANTES (ver mensagem acima).
-- Todos os blocos abaixo são idempotentes (IF EXISTS / IF NOT EXISTS / DO $$).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. User: trocar unique singulares legacy pelos compostos (email/accountType).
--    Origem: migration 20260305194634_add_account_type_to_user
-- -----------------------------------------------------------------------------
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_email_key";
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_documentNumber_key";
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_documentNumberClean_key";
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_googleId_key";
DROP INDEX IF EXISTS "User_email_key";
DROP INDEX IF EXISTS "User_documentNumber_key";
DROP INDEX IF EXISTS "User_documentNumberClean_key";
DROP INDEX IF EXISTS "User_googleId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "User_email_accountType_key"
  ON "User"("email", "accountType");
CREATE UNIQUE INDEX IF NOT EXISTS "User_documentNumberClean_accountType_key"
  ON "User"("documentNumberClean", "accountType")
  WHERE "documentNumberClean" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "User_googleId_accountType_key"
  ON "User"("googleId", "accountType")
  WHERE "googleId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "User_email_accountType_idx"
  ON "User"("email", "accountType");
CREATE INDEX IF NOT EXISTS "User_accountType_idx"
  ON "User"("accountType");

-- -----------------------------------------------------------------------------
-- 2. Event.slug unique (faltando)
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "Event_slug_key" ON "Event"("slug");

-- -----------------------------------------------------------------------------
-- 3. Order.idempotencyKey unique (faltando)
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "Order_idempotencyKey_key"
  ON "Order"("idempotencyKey");

-- -----------------------------------------------------------------------------
-- 4. Registration por usuário ordenado por data
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "Registration_userId_createdAt_idx"
  ON "Registration"("userId", "createdAt");

-- -----------------------------------------------------------------------------
-- 5. Payment.orderId / Registration.orderId NOT NULL
--    Validar antes que SELECT COUNT(*) WHERE "orderId" IS NULL retorna 0.
-- -----------------------------------------------------------------------------
ALTER TABLE "Payment"      ALTER COLUMN "orderId" SET NOT NULL;
ALTER TABLE "Registration" ALTER COLUMN "orderId" SET NOT NULL;

-- -----------------------------------------------------------------------------
-- 6. FKs faltantes (8 constraints)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrganizationMember_userId_fkey') THEN
    ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrganizationAuditLog_actorUserId_fkey') THEN
    ALTER TABLE "OrganizationAuditLog" ADD CONSTRAINT "OrganizationAuditLog_actorUserId_fkey"
      FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrganizerAuditPageDedupe_actorUserId_fkey') THEN
    ALTER TABLE "OrganizerAuditPageDedupe" ADD CONSTRAINT "OrganizerAuditPageDedupe_actorUserId_fkey"
      FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Registration_userId_fkey') THEN
    ALTER TABLE "Registration" ADD CONSTRAINT "Registration_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Registration_invitedById_fkey') THEN
    ALTER TABLE "Registration" ADD CONSTRAINT "Registration_invitedById_fkey"
      FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_userId_fkey') THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_userId_fkey') THEN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LinkedUser_mainUserId_fkey') THEN
    ALTER TABLE "LinkedUser" ADD CONSTRAINT "LinkedUser_mainUserId_fkey"
      FOREIGN KEY ("mainUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 7. Coluna legacy Organization.pix — pode deixar (não afeta nada) ou dropar.
--    Como tem dados, fica como está. Se quiser limpar:
-- ALTER TABLE "Organization" DROP COLUMN IF EXISTS "pix";
-- -----------------------------------------------------------------------------

COMMIT;
