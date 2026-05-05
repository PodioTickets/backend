-- AlterTable Event: data de bloqueio das configurações financeiras ao publicar
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "financialSettingsLockedAt" TIMESTAMP(3);
