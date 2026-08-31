-- Cria a tabela OrganizationPixKey, que existia no schema.prisma mas nunca teve
-- migration própria (foi criada fora do histórico, via db push, no banco de
-- homologação). Sem ela, a migration 20260507000001_add_pix_key_bank_fields
-- falha em qualquer banco novo com: relation "OrganizationPixKey" does not exist.
--
-- Tudo é idempotente (IF NOT EXISTS / guarda no DO) para que bancos que já
-- possuem a tabela apenas registrem a migration, sem alterações.

-- CreateTable
CREATE TABLE IF NOT EXISTS "OrganizationPixKey" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "keyType" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationPixKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OrganizationPixKey_organizationId_idx" ON "OrganizationPixKey"("organizationId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OrganizationPixKey_organizationId_fkey'
  ) THEN
    ALTER TABLE "OrganizationPixKey"
      ADD CONSTRAINT "OrganizationPixKey_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
