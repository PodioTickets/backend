-- Local do evento por coordenadas (seleção no mapa do Google no editor).
-- `googleMapsLink` continua sendo derivado destas no front (query=lat,lng) para
-- manter o embed público. Todas nullable, sem default: eventos existentes ficam
-- com NULL e seguem usando apenas o `googleMapsLink` legado.
ALTER TABLE "Event" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "Event" ADD COLUMN "longitude" DOUBLE PRECISION;
ALTER TABLE "Event" ADD COLUMN "locationName" TEXT;
