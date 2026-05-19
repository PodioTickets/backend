-- Limpeza retroativa de chaves órfãs em Event.kit_selection_display.
--
-- Contexto: até a versão atual, os fluxos de hard-delete de Ticket e
-- TicketCategory não removiam o ID excluído de
--   - primaryKitProductByTicketId   (chave = ticketId)
--   - primaryKitProductByCategoryId (chave = categoryId)
-- O JSON ficava com chaves apontando para registros que não existem mais,
-- e o validator assertKitSelectionDisplayConsistent passava a rejeitar
-- qualquer PATCH /events/:id subsequente (BadRequestException 400).
--
-- O fix de código já impede que novas exclusões criem órfãos; esta migration
-- limpa o estado já sujo no banco. Idempotente: rodar de novo é no-op porque
-- nenhuma linha satisfaz a condição "ticket/categoria órfã".
--
-- Estratégia:
--   1. Para cada Event com kit_selection_display não-nulo, reconstrói cada
--      sub-mapa contendo apenas chaves que ainda existem no banco (com o
--      mesmo eventId — defesa em profundidade contra IDs de outro evento).
--   2. A chave literal 'uncategorized' (UNCATEGORIZED_CATEGORY_KEY) é
--      preservada por design — não corresponde a UUID de categoria real.
--   3. Comparações de UUID via LOWER() para tolerar variações históricas
--      de casing (Prisma retorna lowercase, mas seria silencioso e perigoso
--      dropar uma chave válida só por casing divergente).
--   4. Se algum sub-mapa não for um objeto JSON (ex.: null, array — estado
--      malformado), é normalizado para {} no write-back.
--   5. UPDATE só é aplicado em eventos onde houve mudança efetiva — evita
--      escrita desnecessária e mantém updatedAt intacto nos eventos limpos.

WITH event_kit AS (
  SELECT
    e.id AS event_id,
    e.kit_selection_display AS kit,
    CASE
      WHEN jsonb_typeof(e.kit_selection_display->'primaryKitProductByTicketId') = 'object'
        THEN e.kit_selection_display->'primaryKitProductByTicketId'
      ELSE '{}'::jsonb
    END AS ticket_map,
    CASE
      WHEN jsonb_typeof(e.kit_selection_display->'primaryKitProductByCategoryId') = 'object'
        THEN e.kit_selection_display->'primaryKitProductByCategoryId'
      ELSE '{}'::jsonb
    END AS category_map
  FROM "Event" e
  WHERE e.kit_selection_display IS NOT NULL
    AND jsonb_typeof(e.kit_selection_display) = 'object'
),
cleaned AS (
  SELECT
    ek.event_id,
    COALESCE(
      (
        SELECT jsonb_object_agg(tm.key, tm.value)
        FROM jsonb_each(ek.ticket_map) AS tm(key, value)
        WHERE EXISTS (
          SELECT 1 FROM "Ticket" tk
          WHERE tk."eventId" = ek.event_id
            AND LOWER(tk.id::text) = LOWER(tm.key)
        )
      ),
      '{}'::jsonb
    ) AS clean_ticket_map,
    COALESCE(
      (
        SELECT jsonb_object_agg(cm.key, cm.value)
        FROM jsonb_each(ek.category_map) AS cm(key, value)
        WHERE cm.key = 'uncategorized'
           OR EXISTS (
             SELECT 1 FROM "TicketCategory" tc
             WHERE tc."eventId" = ek.event_id
               AND LOWER(tc.id::text) = LOWER(cm.key)
           )
      ),
      '{}'::jsonb
    ) AS clean_category_map
  FROM event_kit ek
)
UPDATE "Event" e
SET kit_selection_display = jsonb_set(
  jsonb_set(
    e.kit_selection_display,
    '{primaryKitProductByTicketId}',
    c.clean_ticket_map,
    true
  ),
  '{primaryKitProductByCategoryId}',
  c.clean_category_map,
  true
)
FROM cleaned c
WHERE e.id = c.event_id
  AND (
    COALESCE(e.kit_selection_display->'primaryKitProductByTicketId', '{}'::jsonb)
      IS DISTINCT FROM c.clean_ticket_map
    OR COALESCE(e.kit_selection_display->'primaryKitProductByCategoryId', '{}'::jsonb)
      IS DISTINCT FROM c.clean_category_map
  );
