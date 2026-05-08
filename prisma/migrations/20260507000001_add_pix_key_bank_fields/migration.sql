-- Adiciona campos bancários às chaves PIX da organização
ALTER TABLE "OrganizationPixKey"
  ADD COLUMN IF NOT EXISTS "bankName"              TEXT,
  ADD COLUMN IF NOT EXISTS "accountHolderName"     TEXT,
  ADD COLUMN IF NOT EXISTS "accountHolderDocument" TEXT;
