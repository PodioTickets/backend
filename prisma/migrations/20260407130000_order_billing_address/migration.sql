-- Endereço de cobrança no checkout (LGPD: dado pessoal do comprador)
ALTER TABLE "Order" ADD COLUMN "billingCountry" TEXT;
ALTER TABLE "Order" ADD COLUMN "billingPostalCode" TEXT;
ALTER TABLE "Order" ADD COLUMN "billingStateUf" TEXT;
ALTER TABLE "Order" ADD COLUMN "billingStreet" TEXT;
ALTER TABLE "Order" ADD COLUMN "billingNumber" TEXT;
ALTER TABLE "Order" ADD COLUMN "billingComplement" TEXT;
ALTER TABLE "Order" ADD COLUMN "billingNeighborhood" TEXT;
ALTER TABLE "Order" ADD COLUMN "billingCity" TEXT;
