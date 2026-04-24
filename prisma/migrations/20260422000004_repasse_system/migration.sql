-- AlterTable Event: taxas configuráveis por evento
ALTER TABLE "Event" ADD COLUMN "organizerFeeRate" DOUBLE PRECISION NOT NULL DEFAULT 0.04;
ALTER TABLE "Event" ADD COLUMN "retentionRate"    DOUBLE PRECISION NOT NULL DEFAULT 0.10;

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

-- CreateTable EventWithdrawal
CREATE TABLE "EventWithdrawal" (
    "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
    "eventId"       UUID         NOT NULL,
    "requestedById" UUID         NOT NULL,
    "amount"        INTEGER      NOT NULL,
    "feeRate"       DOUBLE PRECISION NOT NULL,
    "feeAmount"     INTEGER      NOT NULL,
    "netAmount"     INTEGER      NOT NULL,
    "status"        "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "notes"         TEXT,
    "completedAt"   TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable EventAudit
CREATE TABLE "EventAudit" (
    "id"                UUID         NOT NULL DEFAULT gen_random_uuid(),
    "eventId"           UUID         NOT NULL,
    "auditedById"       UUID         NOT NULL,
    "retentionReleased" INTEGER      NOT NULL,
    "notes"             TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventAudit_eventId_key" ON "EventAudit"("eventId");
CREATE INDEX "EventWithdrawal_eventId_idx"          ON "EventWithdrawal"("eventId");
CREATE INDEX "EventWithdrawal_eventId_status_idx"   ON "EventWithdrawal"("eventId", "status");
CREATE INDEX "EventWithdrawal_eventId_createdAt_idx" ON "EventWithdrawal"("eventId", "createdAt");

-- AddForeignKey
ALTER TABLE "EventWithdrawal" ADD CONSTRAINT "EventWithdrawal_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventWithdrawal" ADD CONSTRAINT "EventWithdrawal_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventAudit" ADD CONSTRAINT "EventAudit_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventAudit" ADD CONSTRAINT "EventAudit_auditedById_fkey"
    FOREIGN KEY ("auditedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
