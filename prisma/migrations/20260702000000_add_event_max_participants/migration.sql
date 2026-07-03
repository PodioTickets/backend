-- Vagas do evento: teto MÁXIMO de participantes (inscrições) no evento inteiro.
-- NULL = ilimitado (comportamento histórico — só os lotes limitam). Nullable, sem
-- default: eventos existentes ficam sem teto e mantêm o comportamento atual.
ALTER TABLE "Event" ADD COLUMN "maxParticipants" INTEGER;
