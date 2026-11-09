-- Cupom QUANTITY: "Acumular descontos" com cupom de código (manual). Default false — inclusive
-- nos cupons já existentes (decisão do usuário, 2026-11-09): sem a opção, o manual tira o automático.
-- ADD COLUMN com default constante não reescreve a "Coupon" (Postgres 11+), só o catálogo.
ALTER TABLE "Coupon" ADD COLUMN "allowStacking" BOOLEAN NOT NULL DEFAULT false;
