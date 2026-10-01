-- Cupom QUANTITY passa a ter faixa (min/max). Coluna nullable sem default:
-- ADD COLUMN só altera o catálogo, sem reescrever nem travar a "Coupon".
-- NULL = sem máximo (comportamento atual dos cupons existentes).
ALTER TABLE "Coupon" ADD COLUMN "maxQuantity" INTEGER;
