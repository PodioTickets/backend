-- Ingresso passa a ter quantidade MÁXIMA por pedido (par da mínima). Coluna nullable sem
-- default: ADD COLUMN só altera o catálogo, sem reescrever nem travar a "Ticket".
-- NULL = sem máximo (comportamento atual dos ingressos existentes).
ALTER TABLE "Ticket" ADD COLUMN "maxPurchaseQuantity" INTEGER;
