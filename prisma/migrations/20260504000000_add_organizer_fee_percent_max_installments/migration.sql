-- AlterTable Event: taxa absorvida pelo organizador e máximo de parcelas sem juros
ALTER TABLE "Event" ADD COLUMN "organizerFeePercent" DOUBLE PRECISION NOT NULL DEFAULT 0.0;
ALTER TABLE "Event" ADD COLUMN "maxInstallments" INTEGER NOT NULL DEFAULT 1;
