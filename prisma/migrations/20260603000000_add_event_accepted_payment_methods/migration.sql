-- Formas de pagamento aceitas POR EVENTO.
--
-- CONTEXTO
--   `acceptedPaymentMethods` era HARDCODED na resposta do GET /financial-settings
--   (sempre ['PIX','DEBIT_CARD','CREDIT_CARD']) e o checkout aceitava qualquer
--   método do enum. A tela financeira agora permite ao organizador/admin escolher
--   quais formas ficam disponíveis (checkbox por método, mínimo 1).
--
-- O QUE ADICIONA
--   - acceptedPaymentMethods: array do enum PaymentMethod já existente.
--     NOT NULL DEFAULT [PIX, DEBIT_CARD, CREDIT_CARD] → eventos EXISTENTES são
--     backfillados com todos os métodos, preservando EXATAMENTE o comportamento
--     atual. O PATCH /financial-settings passa a aceitar o campo (lock de
--     publicação se aplica igual aos demais campos) e o POST /orders/:id/pay
--     valida o método contra esta whitelist.
--
-- Enum array (Postgres). Aditiva.

ALTER TABLE "Event" ADD COLUMN "acceptedPaymentMethods" "PaymentMethod"[] NOT NULL DEFAULT ARRAY['PIX', 'DEBIT_CARD', 'CREDIT_CARD']::"PaymentMethod"[];
