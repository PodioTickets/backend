-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('USER', 'ORGANIZER');

-- AlterTable: Adicionar coluna accountType com default 'USER'
ALTER TABLE "User" ADD COLUMN "accountType" "AccountType" NOT NULL DEFAULT 'USER';

-- Remover constraints únicos antigos (se existirem)
-- Usando DROP CONSTRAINT IF EXISTS que é mais seguro
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_email_key";
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_documentNumberClean_key";
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_googleId_key";

-- Criar novos constraints únicos compostos
CREATE UNIQUE INDEX "User_email_accountType_key" ON "User"("email", "accountType");
CREATE UNIQUE INDEX "User_documentNumberClean_accountType_key" ON "User"("documentNumberClean", "accountType") WHERE "documentNumberClean" IS NOT NULL;
CREATE UNIQUE INDEX "User_googleId_accountType_key" ON "User"("googleId", "accountType") WHERE "googleId" IS NOT NULL;

-- Criar índices para performance
CREATE INDEX "User_email_accountType_idx" ON "User"("email", "accountType");
CREATE INDEX "User_accountType_idx" ON "User"("accountType");
