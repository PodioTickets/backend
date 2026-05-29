 Agora o diagrama técnico completo do fluxo, como está no código (com arquivos e métodos reais):

  ╔══════════════════════════════════════════════════════════════════════════════════╗
  ║  FASE 1 — CHECKOUT / RESERVA                                          OrdersService ║
  ╚══════════════════════════════════════════════════════════════════════════════════╝
    reserve()
      └─ cria Order(status=PENDING) + Registrations placeholder(status=PENDING)
         + reservedTickets[]  (segura estoque, define expiresAt)
    patchParticipants() / patchProducts() / patchCoupon()
      └─ grava pendingParticipants[], pendingProducts[], couponId/voucherId
         e calcula desconto (cupom/voucher, applyToProducts, guard anti-double-count)

  ╔══════════════════════════════════════════════════════════════════════════════════╗
  ║  FASE 2 — PAGAMENTO  (OrdersService.pay → CieloService)                              ║
  ╚══════════════════════════════════════════════════════════════════════════════════╝
                           pay()  → chama a Cielo conforme o método
          ┌───────────────┬───────────────────┬─────────────────────┬──────────────────┐
          ▼               ▼                   ▼                     ▼                  ▼
    CARTÃO À VISTA    CARTÃO 3DS          DÉBITO 3DS              PIX           (grátis/100% cupom)
    / DÉBITO s/3DS        │                   │                    │                  │
          │           redireciona          redireciona        retorna QR             │
          │           p/ banco             p/ banco           ao cliente             │
          │               │                   │                    │                  │
          │          (cliente autentica)  (cliente autentica)  (cliente paga)         │
          ▼               ▼                   ▼              ┌─────┴───────┐          ▼
    pay() finaliza   handle3dsCallback   handle3dsCallback  │             │     pay() finaliza
    INLINE na mesma  (webhook.service)   (webhook.service)  ▼             ▼     INLINE
    transação            │                   │         handleWebhook  pollPixStatus
          │               │                   │         (Cielo avisa) (front pergunta
          │               │                   │              │         a cada 5s)
          │               │                   │              │             │
          └───────┬───────┴─────────┬─────────┴──────┬───────┘             │
                  │                 │                │                     │
                  │  (guard atômico p/ não finalizar 2x — quem chegar      │
                  │   primeiro vence; os outros viram no-op idempotente)   │
                  ▼                 ▼                ▼                      ▼
  ╔══════════════════════════════════════════════════════════════════════════════════╗
  ║  PONTO ÚNICO DE CONFIRMAÇÃO        OrderFinalizationService.confirmAndFinalizeOrder  ║
  ╚══════════════════════════════════════════════════════════════════════════════════╝
     1) UPDATE Order PENDING→PAID  (se já não era PENDING → para aqui, idempotente)
     2) finalizePaidOrder():
          • aplica uso do cupom (QUANTITY: +1 atômico / DISCOUNT-AGE: +ticketCount com cap)
          • marca voucher ACTIVE→USED
          • apaga placeholders PENDING e CRIA as inscrições reais, 1 por participante:
              nome/documento, RegistrationTicket(+snapshot), RegistrationProduct,
              qrCode, receiptSnapshot (recibo congelado)
     3) (no PIX) o webhook congela em payment.metadata o que precisar p/ histórico
     [tudo dentro de 1 transação com timeout estendido (30s) p/ pedidos grandes]
                                    │
                                    ▼
                         Pedido PAGO + inscrições completas + e-mail/PDF

  ╔══════════════════════════════════════════════════════════════════════════════════╗
  ║  FASE 3 — MATURAÇÃO DO DINHEIRO   RepasseService.calcBreakdown (FONTE ÚNICA)         ║
  ╚══════════════════════════════════════════════════════════════════════════════════╝
    Para cada pedido PAGO, o líquido do organizador (orgNet) entra num "balde":

    orgNet = round( (finalAmount − serviceFee) × (1 − organizerFeePercent/100) )

    À VISTA / PIX / DÉBITO            prazo (RETENTION_DAYS: PIX 1d, débito 2d, crédito 31d)
    ┌───────────────┐  passou prazo  ┌──────────────────────┐  auditoria  ┌───────────────┐
    │ aguardando     │ ─────────────► │ 90% saldoDisponível   │ ──────────► │ +10% liberado │
    │ Liberação(100%)│                │ 10% valorRetido        │             │ (tudo no saldo)│
    └───────────────┘                └──────────────────────┘             └───────────────┘

    PARCELADO (sem retenção)
    ┌──────────────────────┐ cada parcela vence (~31d) ┌──────────────────┐
    │ parceladosAReceber     │ ────────────────────────►│ saldoDisponível   │
    └──────────────────────┘                           └──────────────────┘

    saldoParaSaque = saldoDisponível − saques (PENDING + COMPLETED)

  ╔══════════════════════════════════════════════════════════════════════════════════╗
  ║  FASE 4 — SAQUE / AUDITORIA                                          RepasseService  ║
  ╚══════════════════════════════════════════════════════════════════════════════════╝
    requestWithdrawal()  → trava (advisory lock), valida saldoParaSaque, cria saque PENDING
          │
          ▼
    completeWithdrawal() → transição ATÔMICA (updateMany where status=PENDING) → COMPLETED
          │  cancelWithdrawal() → idem → CANCELLED
          ▼
    💸 dinheiro transferido (PIX) ao organizador  + e-mail

    auditEvent()/adminReleaseRetention() → cria EventAudit → libera os 10% retidos

  ╔══════════════════════════════════════════════════════════════════════════════════╗
  ║  FASE 5 — ESTORNO (proativo) e CHARGEBACK (involuntário)                            ║
  ╚══════════════════════════════════════════════════════════════════════════════════╝
    A) ESTORNO ADMIN   PaymentsRefundService.refundOrder (POST /admin/orders/:id/refund)
         1) Cielo void/refund (fora da transação)
         2) transação:
            • Payment→REFUNDED, congela {refundType:'REFUND', organizerNetReversed, refundFee}
            • Order→CANCELLED, Registrations→CANCELLED
            • reverseSaleSideEffects() ── cupom −(mesmo que somou) / voucher USED→ACTIVE
            • OrganizationAuditLog
         (se Cielo voltou 'Pending' → marca refundPendingConfirmation)

    B) CHARGEBACK   PaymentsChargebackService.checkChargebacks (cron de hora em hora)
         reconcilePendingRefunds() ── re-checa estornos 'Pending' na Cielo (confirma/limpa
                                      ou marca refundReconcileFailed p/ ação manual)
         scan dos PAID → getPayment → status reversão (Voided/Refunded) → processReversal:
            • Payment→REFUNDED, grava {refundType:'CHARGEBACK'}
            • Order/Registrations→CANCELLED
            • reverseSaleSideEffects()  ◄── MESMA fonte do estorno admin
                                     │
                                     ▼
    EFEITO NO BREAKDOWN (calcBreakdown, via computeRefundImpact — FONTE ÚNICA):
     • orgNet revertido: some sozinho (o pedido REFUNDED sai dos "pagos")
     • saldoDisponível −= taxa de refund 2%  ◄── vale p/ ESTORNO **e** CHARGEBACK
     • se já tinha sacado → saldoParaSaque fica negativo (deve devolver)

  ╔══════════════════════════════════════════════════════════════════════════════════╗
  ║  FASE 6 — O QUE O ORGANIZADOR VÊ                                                    ║
  ╚══════════════════════════════════════════════════════════════════════════════════╝
    EventsService.getFinancial ─┐
    RepasseService.getSummary   ├─► TODOS leem de computeBreakdownForEvent / refund.util
    getRefunded / getInstallments / getPendingReleases / getWithdrawals  (FONTE ÚNICA)
     • saldos (aguardando/retido/parcelas/disponível/para-saque)
     • estornos e chargebacks SEPARADOS (isChargeback) com: devolvido ao cliente,
       orgNet revertido, taxa de refund (2%), motivo

  Fontes únicas de verdade (sem duplicação)

  - OrderFinalizationService → confirmAndFinalizeOrder (confirmar+criar inscrições) e reverseSaleSideEffects (desfazer cupom/voucher). Usados por webhook, 3DS,    
  polling, pay, refund e chargeback.
  - common/utils/refund.util.ts → REFUND_FEE_RATE, isChargeback, computeRefundImpact. Usados por repasse, events e refund.
  - RepasseService.calcBreakdown / computeBreakdownForEvent → todo número financeiro do organizador sai daqui.