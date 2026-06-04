-- Re-deriva `documentList` (lista canônica de elegibilidade) a partir do
-- `cpfList` legado em Coupon e Voucher.
--
-- CONTEXTO
--   O update de cupom/voucher tinha um bug de dual-write: quando o cliente
--   atualizava SÓ o `cpfList` (o front atual é cliente legado e nunca envia
--   `documentList`), o merge caía no `documentList` VELHO do banco — e o
--   `buildDocumentList` prefere documentList quando presente. Resultado:
--   `cpfList` novo + `documentList` antigo (divergentes). A elegibilidade do
--   checkout (`isDocumentInList`) valida pela canônica → o CPF recém-editado
--   era considerado INELEGÍVEL e o voucher cobria o slot errado.
--
-- O QUE FAZ
--   Para registros com `cpfList` não-vazio cuja `documentList` contém APENAS
--   entradas type='CPF' (ou é nula), regrava `documentList` derivada do
--   `cpfList` (strip de formatação, shape {type:'CPF', numberClean}).
--   Listas com entradas não-CPF (ex.: PASSPORT, só possíveis via API nova)
--   NÃO são tocadas — nesses casos a canônica é intencional.
--
-- Idempotente. O fix de código (vouchers/coupons.service) impede novas divergências.

UPDATE "Coupon" c
SET "documentList" = sub.derived
FROM (
  SELECT id,
         (
           SELECT jsonb_agg(jsonb_build_object('type', 'CPF', 'numberClean', regexp_replace(elem, '[^0-9]', '', 'g')))
           FROM jsonb_array_elements_text("cpfList"::jsonb) AS elem
           WHERE regexp_replace(elem, '[^0-9]', '', 'g') <> ''
         ) AS derived
  FROM "Coupon"
  WHERE "cpfList" IS NOT NULL AND jsonb_typeof("cpfList"::jsonb) = 'array'
) sub
WHERE c.id = sub.id
  AND sub.derived IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      -- documentList pode ser escalar/nula em registros legados — só itera arrays
      CASE WHEN jsonb_typeof(c."documentList"::jsonb) = 'array' THEN c."documentList"::jsonb ELSE '[]'::jsonb END
    ) AS d
    WHERE d->>'type' IS DISTINCT FROM 'CPF'
  );

UPDATE "Voucher" v
SET "documentList" = sub.derived
FROM (
  SELECT id,
         (
           SELECT jsonb_agg(jsonb_build_object('type', 'CPF', 'numberClean', regexp_replace(elem, '[^0-9]', '', 'g')))
           FROM jsonb_array_elements_text("cpfList"::jsonb) AS elem
           WHERE regexp_replace(elem, '[^0-9]', '', 'g') <> ''
         ) AS derived
  FROM "Voucher"
  WHERE "cpfList" IS NOT NULL AND jsonb_typeof("cpfList"::jsonb) = 'array'
) sub
WHERE v.id = sub.id
  AND sub.derived IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(v."documentList"::jsonb) = 'array' THEN v."documentList"::jsonb ELSE '[]'::jsonb END
    ) AS d
    WHERE d->>'type' IS DISTINCT FROM 'CPF'
  );
