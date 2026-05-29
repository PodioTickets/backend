-- Nacionalidade propria do perfil vinculado (antes herdava do mainUser).
-- Nullable: registros antigos caem no fallback (country do mainUser) na leitura.
ALTER TABLE "LinkedUser" ADD COLUMN "country" TEXT;
