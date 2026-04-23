-- AlterTable: snapshot completo do ingresso no momento da compra
ALTER TABLE "RegistrationTicket" ADD COLUMN "ticketSnapshot" JSONB;
