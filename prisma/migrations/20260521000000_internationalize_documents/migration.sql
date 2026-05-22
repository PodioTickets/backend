-- Internacionalização de documentos (Fase A — aditiva, zero-downtime).
--
-- Adiciona, em paralelo aos campos legacy (participantCpf, documentNumber),
-- a tripla canônica (documentType, documentNumber, documentNumberClean) em:
--   - Registration (snapshot do participante convidado)
--   - LinkedUser (perfis vinculados)
-- e a coluna `documentList` (shape internacionalizado) em Coupon e Voucher,
-- substituindo `cpfList` na fase de transição.
--
-- Esta migration NÃO dropa nenhuma coluna legacy. O cleanup acontece na
-- fase E (migration futura), após o backend novo estar deployado e
-- monitorado por algumas semanas.
--
-- Estratégia de unique do LinkedUser:
--   - Hoje: UNIQUE(mainUserId, documentNumberClean) — colide se um usuário
--     tem 2 perfis vinculados com mesmo numberClean mas tipos diferentes
--     (CPF vs PASSPORT que normalizam pro mesmo string, caso patológico).
--   - Novo: UNIQUE(mainUserId, documentType, documentNumberClean) — semântica
--     correta. Postgres trata NULLs como distintos no unique composto, então
--     registros legados com documentType=NULL coexistem até o backfill (B).
--
-- Padrão do repo (ver migrations recentes): sem CREATE INDEX CONCURRENTLY
-- (Prisma roda em transação por default). Quando rodar em prod com tabelas
-- grandes, considerar dropar a transação manualmente ou rodar via psql
-- direto fora do `prisma migrate`.

-- ─────────────────────────────────────────────────────────────────────────
-- Registration: snapshot internacionalizado do participante convidado
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "Registration"
  ADD COLUMN "participantDocumentType"        "DocumentType",
  ADD COLUMN "participantDocumentNumber"      TEXT,
  ADD COLUMN "participantDocumentNumberClean" TEXT;

CREATE INDEX IF NOT EXISTS "Registration_participantDocumentNumberClean_idx"
  ON "Registration"("participantDocumentNumberClean");

-- Busca "tem alguém inscrito nesse evento com esse documento?" — usado
-- em detecção de duplicata e dashboards do organizador.
CREATE INDEX IF NOT EXISTS "Registration_eventId_participantDocumentNumberClean_idx"
  ON "Registration"("eventId", "participantDocumentNumberClean");

-- ─────────────────────────────────────────────────────────────────────────
-- LinkedUser: adicionar documentType + trocar unique constraint
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "LinkedUser"
  ADD COLUMN "documentType" "DocumentType";

-- Drop do unique antigo. Nome do constraint segue convenção do Prisma:
-- "<Table>_<col1>_<col2>_key". Usar IF EXISTS pra ser idempotente em
-- ambientes onde o nome historicamente possa divergir.
ALTER TABLE "LinkedUser"
  DROP CONSTRAINT IF EXISTS "LinkedUser_mainUserId_documentNumberClean_key";

-- Unique composta nova. NULLs em documentType são considerados distintos
-- pelo Postgres no unique composto, então registros pré-backfill não
-- colidem entre si.
ALTER TABLE "LinkedUser"
  ADD CONSTRAINT "LinkedUser_mainUserId_documentType_documentNumberClean_key"
  UNIQUE ("mainUserId", "documentType", "documentNumberClean");

CREATE INDEX IF NOT EXISTS "LinkedUser_mainUserId_documentType_idx"
  ON "LinkedUser"("mainUserId", "documentType");

-- ─────────────────────────────────────────────────────────────────────────
-- Coupon / Voucher: documentList em paralelo a cpfList
-- ─────────────────────────────────────────────────────────────────────────
-- Shape: [{ "type": "CPF" | "PASSPORT", "numberClean": string }]
-- O service prefere documentList quando ambos estão presentes; fallback
-- pra cpfList apenas em cupons legados que não foram migrados ainda
-- (a migration B faz o backfill).
ALTER TABLE "Coupon"
  ADD COLUMN "documentList" JSONB;

ALTER TABLE "Voucher"
  ADD COLUMN "documentList" JSONB;
