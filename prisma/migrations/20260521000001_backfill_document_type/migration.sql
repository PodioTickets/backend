-- Backfill de internacionalização de documentos (Fase B).
--
-- Assume CPF para todos os registros pré-existentes (verdade histórica:
-- até hoje 100% dos cadastros são brasileiros). Idempotente — UPDATEs
-- filtram por "campo novo IS NULL", então rodar de novo é no-op.
--
-- Tabelas pequenas no estado atual (~milhares de linhas no máximo),
-- então um único UPDATE é suficiente. Se Registration crescer pra 10M+
-- no futuro, rodar manualmente em batches (WHERE id > :cursor + LIMIT)
-- fora do `prisma migrate`.

-- ─────────────────────────────────────────────────────────────────────────
-- Registration: copia participantCpf → participantDocumentNumber e
-- marca tipo como CPF.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE "Registration"
SET
  "participantDocumentType"        = 'CPF',
  "participantDocumentNumber"      = "participantCpf",
  "participantDocumentNumberClean" = "participantCpfClean"
WHERE "participantCpf" IS NOT NULL
  AND "participantDocumentType" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- LinkedUser: marca tipo como CPF onde houver documento (documentNumber
-- e documentNumberClean já existem; só preenche o tipo).
-- ─────────────────────────────────────────────────────────────────────────
UPDATE "LinkedUser"
SET "documentType" = 'CPF'
WHERE "documentNumber" IS NOT NULL
  AND "documentType" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- Coupon.documentList: converte cpfList legado em array de objetos.
-- Cada entrada vira { "type": "CPF", "numberClean": "<dígitos>" }.
-- Filtra entradas não-string e normaliza pra dígitos (sem máscara) — alguns
-- cupons antigos foram criados com CPFs formatados.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE "Coupon" c
SET "documentList" = sub.list
FROM (
  SELECT
    c2.id,
    jsonb_agg(
      jsonb_build_object(
        'type', 'CPF',
        'numberClean', regexp_replace(item::text, '\D', '', 'g')
      )
    ) AS list
  FROM "Coupon" c2,
       jsonb_array_elements_text(c2."cpfList") AS item
  WHERE c2."cpfList" IS NOT NULL
    AND jsonb_typeof(c2."cpfList") = 'array'
    AND c2."documentList" IS NULL
  GROUP BY c2.id
) sub
WHERE c.id = sub.id;

-- ─────────────────────────────────────────────────────────────────────────
-- Voucher.documentList: idem.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE "Voucher" v
SET "documentList" = sub.list
FROM (
  SELECT
    v2.id,
    jsonb_agg(
      jsonb_build_object(
        'type', 'CPF',
        'numberClean', regexp_replace(item::text, '\D', '', 'g')
      )
    ) AS list
  FROM "Voucher" v2,
       jsonb_array_elements_text(v2."cpfList") AS item
  WHERE v2."cpfList" IS NOT NULL
    AND jsonb_typeof(v2."cpfList") = 'array'
    AND v2."documentList" IS NULL
  GROUP BY v2.id
) sub
WHERE v.id = sub.id;
