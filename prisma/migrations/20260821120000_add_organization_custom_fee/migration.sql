-- Taxa de organizador PERSONALIZADA por organização. DESLIGADA por padrão — o admin
-- ativa no drawer da organização e define o teto da taxa total (%) que o organizador
-- pode configurar por evento. Com o toggle desligado, o teto efetivo é o fixo de 6%.
ALTER TABLE "Organization" ADD COLUMN "customFeeEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organization" ADD COLUMN "maxTotalFeePercent" DOUBLE PRECISION NOT NULL DEFAULT 6;
