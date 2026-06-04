-- Índices pras agregações do dashboard/funil de atividade (/admin/atividade).
--
-- 1) (action, occurredAt): funil de compra e séries de page view filtram por
--    action exato + range de data — range-scan direto, sem varrer a tabela.
-- 2) Expressão sobre metadata->>'eventId': filtro "por evento" do dashboard.
--    Parcial (só linhas COM o vínculo) — page views e checkout são minoria do
--    volume total, então o índice fica pequeno e barato de manter.

CREATE INDEX IF NOT EXISTS "UserActivityLog_action_occurredAt_idx"
  ON "UserActivityLog" ("action", "occurredAt");

CREATE INDEX IF NOT EXISTS "UserActivityLog_metadata_eventId_occurredAt_idx"
  ON "UserActivityLog" ((("metadata"->>'eventId')), "occurredAt")
  WHERE ("metadata"->>'eventId') IS NOT NULL;
