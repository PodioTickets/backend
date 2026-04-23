-- Adiciona coluna de snapshot completo (substitui colunas individuais adicionadas anteriormente)
ALTER TABLE "RegistrationTicket" ADD COLUMN IF NOT EXISTS "ticketSnapshot" JSONB;

-- Remove colunas individuais adicionadas pela migration anterior (agora desnecessárias)
ALTER TABLE "RegistrationTicket" DROP COLUMN IF EXISTS "ticketName";
ALTER TABLE "RegistrationTicket" DROP COLUMN IF EXISTS "batchPrice";
ALTER TABLE "RegistrationTicket" DROP COLUMN IF EXISTS "batchName";
