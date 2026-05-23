-- Adiciona infraestrutura de logging granular de atividade de usuário.
--
-- Cobre 4 casos de uso simultaneamente (analytics, auditoria, segurança,
-- compliance/LGPD). Diferente de OrganizationAuditLog (escopo organizacional,
-- baixo volume), esta tabela atende usuário final + anônimo → alto volume,
-- portanto:
--   - Insert-only; gravação em batch via service (createMany).
--   - userId nullable (anônimo pré-login).
--   - sessionId nullable (costura jornada anônima → autenticada).
--   - Índice em (occurredAt) pra cron de retenção fazer DELETE eficiente.
--   - Enums (smallint internamente) reduzem tamanho de índice em ~4x vs string.
--
-- Migração aditiva — não toca em nenhuma tabela existente. Cleanup futuro
-- (DELETE em massa) é executado por cron, não por migration.

-- CreateEnum
CREATE TYPE "UserActivitySource" AS ENUM ('FRONTEND', 'BACKEND', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "UserActivityCategory" AS ENUM ('PAGE_VIEW', 'CLICK', 'API', 'AUTH', 'CHECKOUT', 'PROFILE', 'COMPLIANCE', 'OTHER');

-- CreateTable
CREATE TABLE "UserActivityLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID,
    "sessionId" VARCHAR(64),
    "ip" TEXT,
    "userAgent" TEXT,
    "source" "UserActivitySource" NOT NULL,
    "category" "UserActivityCategory" NOT NULL,
    "action" TEXT NOT NULL,
    "path" TEXT,
    "referrer" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserActivityLog_userId_occurredAt_idx" ON "UserActivityLog"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "UserActivityLog_sessionId_occurredAt_idx" ON "UserActivityLog"("sessionId", "occurredAt");

-- CreateIndex
CREATE INDEX "UserActivityLog_category_occurredAt_idx" ON "UserActivityLog"("category", "occurredAt");

-- CreateIndex
CREATE INDEX "UserActivityLog_occurredAt_idx" ON "UserActivityLog"("occurredAt");

-- AddForeignKey
ALTER TABLE "UserActivityLog" ADD CONSTRAINT "UserActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
