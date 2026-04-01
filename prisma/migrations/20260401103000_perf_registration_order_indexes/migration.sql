-- Performance: listagem por convidado ordenada; métricas por evento + data do pedido
CREATE INDEX IF NOT EXISTS "Registration_invitedById_createdAt_idx" ON "Registration"("invitedById", "createdAt");
CREATE INDEX IF NOT EXISTS "Order_eventId_createdAt_idx" ON "Order"("eventId", "createdAt");
