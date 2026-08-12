-- Registro de aceite eletrônico de contratos pelo organizador (auto-cadastro).
-- Prova da manifestação de vontade (Contrato Principal, cl. 4.4): um registro por
-- contrato aceito, com versão, IP e user-agent. Idempotente (IF NOT EXISTS).

-- CreateTable
CREATE TABLE IF NOT EXISTS "ContractAcceptance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "organizationId" UUID,
    "contractId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractAcceptance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ContractAcceptance_userId_idx" ON "ContractAcceptance"("userId");
CREATE INDEX IF NOT EXISTS "ContractAcceptance_organizationId_idx" ON "ContractAcceptance"("organizationId");
CREATE INDEX IF NOT EXISTS "ContractAcceptance_contractId_version_idx" ON "ContractAcceptance"("contractId", "version");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ContractAcceptance_userId_fkey'
  ) THEN
    ALTER TABLE "ContractAcceptance" ADD CONSTRAINT "ContractAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ContractAcceptance_organizationId_fkey'
  ) THEN
    ALTER TABLE "ContractAcceptance" ADD CONSTRAINT "ContractAcceptance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
