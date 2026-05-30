-- Reconciliação de Orders "órfãos" do bug legado de finalização PIX/3DS (pré 2026-05-28).
--
-- CONTEXTO
--   O fluxo antigo de confirmação (polling do PIX e webhook PIX/3DS, antes da extração
--   do OrderFinalizationService) marcava Registration = CONFIRMED e Payment = PAID, mas
--   NÃO promovia o Order (ficava preso em 'PENDING'). Resultado: divergência no dashboard
--   entre `metrics.netRevenue` (chaveia por Registration CONFIRMED + Payment PAID) e
--   `salesByPaymentMethod` (exige Order.status = 'PAID'). O fix de código
--   (confirmAndFinalizeOrder — fonte única; promove o Order atomicamente ANTES de finalizar)
--   parou de gerar NOVOS casos, mas não sanou os pedidos já gravados.
--
-- O QUE ESTA MIGRATION FAZ
--   Apenas alinha o status FINANCEIRO do Order: promove a 'PAID' todo pedido ainda 'PENDING'
--   que comprovadamente já foi pago (payment PAID) e tem inscrição confirmada. É a verdade
--   do dado — se há pagamento PAID + inscrição CONFIRMED, o pedido está pago.
--
-- O QUE ESTA MIGRATION **NÃO** FAZ
--   NÃO recria as inscrições vazias (placeholders flipados p/ CONFIRMED sem
--   participante/ticket/snapshot). Esse backfill exige a lógica de finalize em TS
--   (snapshot do recibo, qrCode, RegistrationTicket/Product, uso de cupom/voucher) que vive
--   no `OrderFinalizationService.finalizePaidOrder` — fonte única. Reescrevê-la em SQL aqui
--   duplicaria a regra e quebraria a manutenibilidade. Rode o comando manual pós-deploy:
--       pnpm reconcile:orphan-orders --dry-run   # inspeciona
--       pnpm reconcile:orphan-orders --apply     # aplica
--
-- IDEMPOTÊNCIA
--   O WHERE filtra status = 'PENDING' com evidência de pagamento confirmado; rodar de novo
--   é no-op (os pedidos já estarão 'PAID'). Seguro para reexecução do `migrate deploy`.

UPDATE "Order" o
SET "status"    = 'PAID'::"OrderStatus",
    "updatedAt" = NOW()
WHERE o."status" = 'PENDING'::"OrderStatus"
  AND EXISTS (
    SELECT 1 FROM "Payment" p
    WHERE p."orderId" = o.id
      AND p."status" = 'PAID'::"PaymentStatus"
  )
  AND EXISTS (
    SELECT 1 FROM "Registration" r
    WHERE r."orderId" = o.id
      AND r."status" = 'CONFIRMED'::"RegistrationStatus"
  );
