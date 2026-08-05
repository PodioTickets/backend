-- Taxa MENSAL de antecipação de recebíveis por organização (fração: 0.1 = 10%).
ALTER TABLE "Organization" ADD COLUMN "anticipationMonthlyRate" DOUBLE PRECISION NOT NULL DEFAULT 0.1;
