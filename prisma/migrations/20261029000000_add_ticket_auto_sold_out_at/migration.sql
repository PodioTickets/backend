-- Esgotamento automático do ingresso: data/hora a partir da qual ele fica ESGOTADO mesmo
-- com vagas. Coluna nullable sem default: ADD COLUMN só altera o catálogo, sem reescrever
-- nem travar a "Ticket". NULL = sem esgotamento programado (comportamento atual).
ALTER TABLE "Ticket" ADD COLUMN "autoSoldOutAt" TIMESTAMP(3);
