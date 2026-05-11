-- Índice composto para listagem de pedidos pagos por evento ordenados por data.
-- Usado pelos endpoints fiscais (GET /events/:id/financial/fiscal-orders e fiscal-export)
-- e por outras agregações que filtram por (eventId, status).
-- CONCURRENTLY evita lock pesado em tabelas grandes em produção.
CREATE INDEX IF NOT EXISTS "Order_eventId_status_createdAt_idx"
  ON "Order" ("eventId", "status", "createdAt" DESC);
