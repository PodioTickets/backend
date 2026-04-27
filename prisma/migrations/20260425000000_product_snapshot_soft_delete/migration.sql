-- Soft delete no Product: permite deletar sem quebrar histórico de compras
ALTER TABLE "Product" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Snapshot do produto no momento da compra
ALTER TABLE "RegistrationProduct" ADD COLUMN "productSnapshot" JSONB;

-- Index para filtrar produtos ativos eficientemente
CREATE INDEX "Product_eventId_deletedAt_idx" ON "Product"("eventId", "deletedAt");
