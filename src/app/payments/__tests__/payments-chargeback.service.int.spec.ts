/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: detecção automática de CHARGEBACK / estorno pelo emissor
 *           (`PaymentsChargebackService.checkChargebacks`, um "cron" diário às 3h BRL).
 *
 *  EM RESUMO:
 *    Depois que um pedido é PAGO, o banco do cliente ainda pode REVERTER o pagamento
 *    (chargeback / estorno involuntário). Esse serviço varre os pagamentos ainda PAGOS,
 *    pergunta à Cielo o status atual de cada transação e, SE a Cielo disser que foi
 *    revertido (status 10 = Voided ou 11 = Refunded), ele:
 *      • marca o Pagamento como REFUNDED (e carimba `refundType: 'CHARGEBACK'`),
 *      • marca o Pedido como CANCELLED (com motivo),
 *      • cancela as inscrições daquele pedido (CONFIRMED/COMPLETED → CANCELLED),
 *      • REVERTE os efeitos da venda: o cupom usado volta a ter `usageCount` menor e o
 *        voucher usado volta de USED → ACTIVE (liberado de novo).
 *
 *    E o que NÃO deve acontecer:
 *      • Pagamento que a Cielo diz estar normal (status 2 = PaymentConfirmed) fica INTACTO.
 *      • Pagamento que JÁ foi classificado como estorno (`metadata.refundType` setado)
 *        é PULADO — não reverte os efeitos de novo (evita decrementar cupom duas vezes).
 *
 *  COMO CONFERIMOS:
 *    Teste DE VERDADE contra um banco de teste (descartável). Semeamos pedidos PAGOS
 *    completos (Order PAID + Payment PAID com transactionId + OrderReservedTicket +
 *    Registration CONFIRMED + Cupom/Voucher consumidos) DIRETO no banco, MOCKAMOS apenas
 *    a Cielo (a consulta de status de transação) e usamos o OrderFinalizationService REAL.
 *    Depois lemos o banco de volta e conferimos os efeitos.
 *
 *  PREMISSAS / NOTAS PARA QUEM FOR RODAR:
 *    • A Cielo é a ÚNICA dependência mockada. `cieloService.getPayment(id)` devolve
 *      `{ Payment: { Status } }` conforme o cenário (11 = chargeback; 2 = normal). Também
 *      expomos `sandboxMode: false` (o cron faz early-return em sandbox) e a função pura
 *      `mapCieloStatusToString` (reaproveitada do serviço real, sem I/O).
 *    • O `OrderFinalizationService` é REAL (`new OrderFinalizationService(prisma)`) — é ele
 *      quem reverte cupom/voucher; queremos validar o efeito REAL no banco.
 *    • O construtor do serviço é `(prisma, cieloService, orderFinalization)`.
 *    • O cron tem um throttle interno de 400ms POR pagamento (rate limit Cielo). Com poucos
 *      pagamentos por cenário o tempo total é pequeno; ainda assim o jest.timeout é elevado.
 *    • `reconcilePendingRefunds` roda ANTES da varredura de PAID; nos cenários sem pagamentos
 *      `refundPendingConfirmation` ele é um no-op (nenhuma linha REFUNDED pendente).
 * ============================================================================
 */
import { PaymentsChargebackService } from '../payments-chargeback.service';
import { OrderFinalizationService } from '../order-finalization.service';
import { CieloService } from '../cielo.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  createTestPrisma,
  resetDb,
  seedOrgUserEvent,
} from '../../../common/testing/integration-db';

/**
 * Stub da Cielo: só o que o cron usa.
 *  - `sandboxMode = false` para o cron NÃO dar early-return.
 *  - `getPayment(id)` resolve o status conforme um mapa transactionId → cieloStatus.
 *  - `mapCieloStatusToString` reusa a implementação pura do serviço real (sem rede).
 */
function makeCieloStub(statusByTxId: Record<string, number>) {
  const real = CieloService.prototype;
  const getPayment = jest.fn(async (paymentId: string) => {
    if (!(paymentId in statusByTxId)) return null;
    return { Payment: { Status: statusByTxId[paymentId] } } as any;
  });
  return {
    sandboxMode: false,
    getPayment,
    mapCieloStatusToString: real.mapCieloStatusToString.bind(real),
  } as unknown as CieloService & { getPayment: jest.Mock };
}

describe('PaymentsChargebackService (integração, banco real)', () => {
  let prisma: PrismaService;
  let orderFinalization: OrderFinalizationService;

  // Telemetria no-op: o alvo do teste são os efeitos no banco, não o log de atividade.
  const activityStub = { record: () => {} } as any;

  jest.setTimeout(30000); // throttle interno de 400ms/pagamento + I/O real

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    orderFinalization = new OrderFinalizationService(prisma, activityStub);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma); // banco limpo antes de cada cenário
  });

  // ── helpers de montagem (criam linhas REAIS no banco de teste) ──────────────

  /** Cria categoria + ticket + lote; devolve ids. */
  const seedTicketWithBatch = async (eventId: string) => {
    const w = prisma.getWriteClient();
    const category = await w.ticketCategory.create({
      data: { eventId, name: 'Lote Único' },
      select: { id: true },
    });
    const ticket = await w.ticket.create({
      data: { eventId, categoryId: category.id, name: 'Ingresso', modality: 'Corrida' },
      select: { id: true },
    });
    const batch = await w.ticketBatch.create({
      data: { ticketId: ticket.id, quantity: 100, availableQuantity: 90, price: 5000 },
      select: { id: true },
    });
    return { ticketId: ticket.id, batchId: batch.id };
  };

  /** Cupom QUANTITY já consumido (usageCount = 1). */
  const seedConsumedCoupon = async (eventId: string) => {
    const coupon = await prisma.getWriteClient().coupon.create({
      data: {
        eventId,
        code: `CUP-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        couponType: 'QUANTITY' as any,
        type: 'PERCENTAGE' as any,
        value: 10,
        minQuantity: 1,
        usageCount: 1, // já consumido por este pedido
        status: 'ACTIVE' as any,
      },
      select: { id: true, usageCount: true },
    });
    return coupon.id;
  };

  /** Voucher USED por `userId` (consumido por este pedido). */
  const seedUsedVoucher = async (eventId: string, userId: string, orderId: string) => {
    const voucher = await prisma.getWriteClient().voucher.create({
      data: {
        eventId,
        name: 'Voucher Teste',
        code: `VCH-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        status: 'USED' as any,
        usedAt: new Date(),
        usedBy: userId,
        reservedByOrderId: orderId,
      },
      select: { id: true },
    });
    return voucher.id;
  };

  /**
   * Monta um pedido PAGO completo (Order PAID + Payment PAID com transactionId +
   * OrderReservedTicket + Registration CONFIRMED). Aceita cupom/voucher já consumidos
   * e um `metadata` opcional do pagamento (para o cenário "já estornado").
   */
  const seedPaidOrder = async (params: {
    eventId: string;
    userId: string;
    ticketId: string;
    batchId: string;
    transactionId: string;
    couponId?: string;
    voucherId?: string;
    paymentMetadata?: Record<string, unknown>;
    quantity?: number;
  }) => {
    const w = prisma.getWriteClient();
    const qty = params.quantity ?? 1;

    const order = await w.order.create({
      data: {
        userId: params.userId,
        eventId: params.eventId,
        status: 'PAID' as any,
        totalAmount: 5000 * qty,
        serviceFee: 0,
        discount: 0,
        finalAmount: 5000 * qty,
        couponId: params.couponId ?? null,
        voucherId: params.voucherId ?? null,
        // pendingParticipants congelado no pay — usado por computeCouponCoveredUnits na reversão.
        pendingParticipants: [{ email: 'p@teste.com', name: 'Participante' }] as any,
      },
      select: { id: true },
    });

    await w.orderReservedTicket.create({
      data: {
        orderId: order.id,
        ticketId: params.ticketId,
        batchId: params.batchId,
        quantity: qty,
        unitPrice: 5000,
      },
    });

    const payment = await w.payment.create({
      data: {
        orderId: order.id,
        userId: params.userId,
        method: 'CREDIT_CARD' as any,
        status: 'PAID' as any,
        amount: 5000 * qty,
        transactionId: params.transactionId,
        paymentDate: new Date(), // dentro da janela CHECK_WINDOW_DAYS (180d)
        ...(params.paymentMetadata && { metadata: params.paymentMetadata as any }),
      },
      select: { id: true },
    });

    await w.registration.create({
      data: {
        eventId: params.eventId,
        orderId: order.id,
        userId: params.userId,
        status: 'CONFIRMED' as any,
      },
    });

    return { orderId: order.id, paymentId: payment.id };
  };

  // ── cenários ────────────────────────────────────────────────────────────────

  it('chargeback detectado (Cielo retorna Refunded=11) → Pedido CANCELLED, Pagamento REFUNDED, inscrições canceladas, cupom e voucher revertidos', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const { ticketId, batchId } = await seedTicketWithBatch(eventId);
    const couponId = await seedConsumedCoupon(eventId);

    // cria o pedido primeiro para amarrar o voucher à reserva deste pedido
    const txId = 'CIELO-TX-CHARGEBACK';
    // o voucher precisa do orderId; criamos o pedido sem voucher, pegamos o id, e então o voucher.
    const { orderId, paymentId } = await seedPaidOrder({
      eventId,
      userId: adminUserId,
      ticketId,
      batchId,
      transactionId: txId,
      couponId,
    });
    const voucherId = await seedUsedVoucher(eventId, adminUserId, orderId);
    // vincula o voucher ao pedido (Order.voucherId) — a reversão lê order.voucherId.
    await prisma.getWriteClient().order.update({
      where: { id: orderId },
      data: { voucherId },
    });

    const cielo = makeCieloStub({ [txId]: 11 }); // 11 = Refunded → chargeback
    const service = new PaymentsChargebackService(prisma, cielo, orderFinalization, activityStub);

    await service.checkChargebacks();

    // a Cielo foi consultada para a transação deste pagamento
    expect(cielo.getPayment).toHaveBeenCalledWith(txId);

    // Pagamento → REFUNDED + classificado como CHARGEBACK
    const payment = await prisma.getWriteClient().payment.findUnique({ where: { id: paymentId } });
    expect(payment?.status).toBe('REFUNDED');
    expect((payment?.metadata as any)?.refundType).toBe('CHARGEBACK');
    expect((payment?.metadata as any)?.reversalType).toBe('Refunded');
    expect((payment?.metadata as any)?.cieloStatus).toBe('Refunded');

    // Pedido → CANCELLED (com motivo e timestamp)
    const order = await prisma.getWriteClient().order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('CANCELLED');
    expect(order?.cancelledAt).not.toBeNull();
    expect(order?.cancelledReason).toBe('Pagamento reembolsado (chargeback ou estorno)');

    // Inscrição CONFIRMED → CANCELLED
    const regs = await prisma.getWriteClient().registration.findMany({ where: { orderId } });
    expect(regs).toHaveLength(1);
    expect(regs[0].status).toBe('CANCELLED');

    // Cupom revertido: usageCount 1 → 0
    const coupon = await prisma.getWriteClient().coupon.findUnique({ where: { id: couponId } });
    expect(coupon?.usageCount).toBe(0);

    // Voucher revertido: USED → ACTIVE + reserva zerada
    const voucher = await prisma.getWriteClient().voucher.findUnique({ where: { id: voucherId } });
    expect(voucher?.status).toBe('ACTIVE');
    expect(voucher?.usedBy).toBeNull();
    expect(voucher?.usedAt).toBeNull();
    expect(voucher?.reservedByOrderId).toBeNull();
  });

  it('Voided=10 também conta como chargeback → Pedido CANCELLED com motivo de cancelamento/estorno pelo emissor', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const { ticketId, batchId } = await seedTicketWithBatch(eventId);

    const txId = 'CIELO-TX-VOIDED';
    const { orderId, paymentId } = await seedPaidOrder({
      eventId,
      userId: adminUserId,
      ticketId,
      batchId,
      transactionId: txId,
    });

    const cielo = makeCieloStub({ [txId]: 10 }); // 10 = Voided
    const service = new PaymentsChargebackService(prisma, cielo, orderFinalization, activityStub);

    await service.checkChargebacks();

    const payment = await prisma.getWriteClient().payment.findUnique({ where: { id: paymentId } });
    expect(payment?.status).toBe('REFUNDED');
    expect((payment?.metadata as any)?.reversalType).toBe('Voided');

    const order = await prisma.getWriteClient().order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('CANCELLED');
    expect(order?.cancelledReason).toBe('Pagamento cancelado/estornado pelo emissor');
  });

  it('pagamento sem chargeback (Cielo retorna PaymentConfirmed=2) → fica TOTALMENTE intacto', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const { ticketId, batchId } = await seedTicketWithBatch(eventId);
    const couponId = await seedConsumedCoupon(eventId);

    const txId = 'CIELO-TX-NORMAL';
    const { orderId, paymentId } = await seedPaidOrder({
      eventId,
      userId: adminUserId,
      ticketId,
      batchId,
      transactionId: txId,
      couponId,
    });
    const voucherId = await seedUsedVoucher(eventId, adminUserId, orderId);
    await prisma.getWriteClient().order.update({ where: { id: orderId }, data: { voucherId } });

    const cielo = makeCieloStub({ [txId]: 2 }); // 2 = PaymentConfirmed → NÃO é reversão
    const service = new PaymentsChargebackService(prisma, cielo, orderFinalization, activityStub);

    await service.checkChargebacks();

    expect(cielo.getPayment).toHaveBeenCalledWith(txId);

    // Pagamento intacto
    const payment = await prisma.getWriteClient().payment.findUnique({ where: { id: paymentId } });
    expect(payment?.status).toBe('PAID');
    expect((payment?.metadata as any)?.refundType).toBeUndefined();

    // Pedido intacto
    const order = await prisma.getWriteClient().order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('PAID');
    expect(order?.cancelledAt).toBeNull();

    // Inscrição intacta
    const regs = await prisma.getWriteClient().registration.findMany({ where: { orderId } });
    expect(regs[0].status).toBe('CONFIRMED');

    // Cupom NÃO revertido
    const coupon = await prisma.getWriteClient().coupon.findUnique({ where: { id: couponId } });
    expect(coupon?.usageCount).toBe(1);

    // Voucher NÃO revertido
    const voucher = await prisma.getWriteClient().voucher.findUnique({ where: { id: voucherId } });
    expect(voucher?.status).toBe('USED');
    expect(voucher?.usedBy).toBe(adminUserId);
  });

  it('pagamento JÁ classificado como estorno (metadata.refundType setado) → é PULADO: Cielo nem é consultada e nada é revertido de novo', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const { ticketId, batchId } = await seedTicketWithBatch(eventId);
    const couponId = await seedConsumedCoupon(eventId);

    const txId = 'CIELO-TX-ALREADY-REFUNDED';
    const { orderId, paymentId } = await seedPaidOrder({
      eventId,
      userId: adminUserId,
      ticketId,
      batchId,
      transactionId: txId,
      couponId,
      // pagamento ainda PAID por inconsistência, mas já carimbado como estorno proativo.
      paymentMetadata: { refundType: 'REFUND' },
    });

    const cielo = makeCieloStub({ [txId]: 11 }); // mesmo que dissesse chargeback, deve ser pulado
    const service = new PaymentsChargebackService(prisma, cielo, orderFinalization, activityStub);

    await service.checkChargebacks();

    // guard `if (meta?.refundType) continue` → a Cielo nem chega a ser consultada
    expect(cielo.getPayment).not.toHaveBeenCalled();

    // Pagamento permanece como estava (PAID, refundType original REFUND)
    const payment = await prisma.getWriteClient().payment.findUnique({ where: { id: paymentId } });
    expect(payment?.status).toBe('PAID');
    expect((payment?.metadata as any)?.refundType).toBe('REFUND');

    // Pedido intacto
    const order = await prisma.getWriteClient().order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('PAID');

    // Cupom NÃO decrementado de novo (continua 1) — evita double-revert
    const coupon = await prisma.getWriteClient().coupon.findUnique({ where: { id: couponId } });
    expect(coupon?.usageCount).toBe(1);
  });

  it('varredura mista: reverte só o pagamento com chargeback e preserva o normal na mesma execução', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const { ticketId, batchId } = await seedTicketWithBatch(eventId);

    const txCB = 'CIELO-TX-MIX-CB';
    const txOk = 'CIELO-TX-MIX-OK';
    const cb = await seedPaidOrder({
      eventId, userId: adminUserId, ticketId, batchId, transactionId: txCB,
    });
    const ok = await seedPaidOrder({
      eventId, userId: adminUserId, ticketId, batchId, transactionId: txOk,
    });

    const cielo = makeCieloStub({ [txCB]: 11, [txOk]: 2 });
    const service = new PaymentsChargebackService(prisma, cielo, orderFinalization, activityStub);

    await service.checkChargebacks();

    const orderCb = await prisma.getWriteClient().order.findUnique({ where: { id: cb.orderId } });
    expect(orderCb?.status).toBe('CANCELLED');

    const orderOk = await prisma.getWriteClient().order.findUnique({ where: { id: ok.orderId } });
    expect(orderOk?.status).toBe('PAID');
  });
});
