-- Camada 4: Constraints de banco para garantir integridade do availableQuantity
-- availableQuantity nunca pode ser negativo nem ultrapassar a capacidade total do lote

ALTER TABLE "TicketBatch"
  ADD CONSTRAINT "TicketBatch_availableQuantity_non_negative"
    CHECK ("availableQuantity" >= 0);

ALTER TABLE "TicketBatch"
  ADD CONSTRAINT "TicketBatch_availableQuantity_within_capacity"
    CHECK ("availableQuantity" <= "quantity");
