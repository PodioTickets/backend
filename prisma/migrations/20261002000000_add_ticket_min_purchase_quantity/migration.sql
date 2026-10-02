-- Ingresso passa a ter quantidade mínima por pedido. Coluna nullable sem default:
-- ADD COLUMN só altera o catálogo, sem reescrever nem travar a "Ticket".
-- NULL = sem mínimo (comportamento atual dos ingressos existentes).
ALTER TABLE "Ticket" ADD COLUMN "minPurchaseQuantity" INTEGER;
