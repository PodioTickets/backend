-- CreateTable EventAnticipation
-- Pedido de antecipação de recebíveis (aguardando liberação à vista), espelhando
-- EventWithdrawal. Reusa o enum "WithdrawalStatus" (PENDING/COMPLETED/CANCELLED).
CREATE TABLE "EventAnticipation" (
    "id"            UUID             NOT NULL DEFAULT gen_random_uuid(),
    "eventId"       UUID             NOT NULL,
    "requestedById" UUID             NOT NULL,
    "amount"        INTEGER          NOT NULL,
    "monthlyRate"   DOUBLE PRECISION NOT NULL,
    "costAmount"    INTEGER          NOT NULL,
    "netAmount"     INTEGER          NOT NULL,
    "status"        "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "notes"         TEXT,
    "receiptUrl"    TEXT,
    "breakdown"     JSONB,
    "completedAt"   TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)     NOT NULL,

    CONSTRAINT "EventAnticipation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventAnticipation_eventId_idx"           ON "EventAnticipation"("eventId");
CREATE INDEX "EventAnticipation_eventId_status_idx"    ON "EventAnticipation"("eventId", "status");
CREATE INDEX "EventAnticipation_eventId_createdAt_idx" ON "EventAnticipation"("eventId", "createdAt");

-- AddForeignKey
ALTER TABLE "EventAnticipation" ADD CONSTRAINT "EventAnticipation_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict: preserva o histórico de antecipações ao remover o membro (mesma regra do saque).
ALTER TABLE "EventAnticipation" ADD CONSTRAINT "EventAnticipation_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
