/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: ESTORNO de um pedido pago (PaymentsRefundService.refundOrder).
 *           Um administrador estorna uma compra; o dinheiro volta pelo gateway
 *           (Cielo) e o sistema precisa "desfazer" os efeitos da venda no banco.
 *
 *  EM RESUMO:
 *    Quando um pedido PAGO é estornado:
 *      • o pagamento passa para REFUNDED (com motivo, autor e carimbo de tempo);
 *      • o pedido em si passa para CANCELLED (não existe status "REFUNDED" de pedido
 *        no schema — quem fica REFUNDED é o PAGAMENTO);
 *      • as inscrições confirmadas são CANCELADAS;
 *      • um eventual CUPOM tem o "usageCount" devolvido (decrementado) — libera 1 uso;
 *      • um eventual VOUCHER volta de USADO para ATIVO e perde a reserva (fica reutilizável);
 *      • fica registrado um log de auditoria (ORDER_REFUND) na organização do evento.
 *    Também: NÃO se pode estornar um pedido que não está PAGO.
 *
 *  COMO CONFERIMOS:
 *    Teste DE VERDADE contra um Postgres de teste descartável. Semeamos um pedido PAGO
 *    completo (evento + ingresso + lote + pedido + pagamento + reserva + inscrições +
 *    cupom/voucher) diretamente no banco e chamamos refundOrder(). A Cielo é MOCKADA
 *    (sem HTTP real); o OrderFinalizationService é REAL (instanciado com o mesmo Prisma
 *    de teste). Depois lemos o banco de volta e conferimos cada efeito.
 *
 *  PREMISSAS / MOCKS:
 *    • CieloService.cancelPayment → mock que devolve sucesso ('Voided'); nenhum outro
 *      método da Cielo é tocado pelo fluxo de refund.
 *    • OrderFinalizationService → REAL (new OrderFinalizationService(prisma)).
 *    • PrismaService → REAL, banco de teste.
 *    • A assinatura pública é por OBJETO: refundOrder({ orderId, adminUserId, reason, force?, ip? }).
 * ============================================================================
 */
import { ConflictException } from '@nestjs/common';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  RegistrationStatus,
} from '@prisma/client';
import { PaymentsRefundService } from '../payments-refund.service';
import { OrderFinalizationService } from '../order-finalization.service';
import { CieloService } from '../cielo.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  createTestPrisma,
  resetDb,
  seedOrgUserEvent,
} from '../../../common/testing/integration-db';

describe('PaymentsRefundService (integração, banco real)', () => {
  let prisma: PrismaService;
  let service: PaymentsRefundService;
  let cieloMock: { cancelPayment: jest.Mock };

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);

    // Cielo MOCKADA — refund sempre "Voided" (estorno síncrono bem-sucedido).
    // success=true e cieloStatus != 'Pending' → efeitos aplicados de forma definitiva.
    cieloMock = {
      cancelPayment: jest.fn().mockResolvedValue({
        success: true,
        paymentId: 'cielo-void-id',
        cieloStatus: 'Voided',
        returnCode: '0',
        returnMessage: 'Operation Successful',
      }),
    };

    // OrderFinalizationService REAL com o MESMO prisma de teste (reverseSaleSideEffects roda de verdade).
    // Telemetria no-op: o alvo do teste são os efeitos no banco, não o log de atividade.
    const activityStub = { record: () => {} } as any;
    const finalization = new OrderFinalizationService(prisma, activityStub);

    service = new PaymentsRefundService(
      prisma,
      cieloMock as unknown as CieloService,
      finalization,
      activityStub,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Helpers de seed: monta um pedido PAGO completo direto no banco (write client).
  // ───────────────────────────────────────────────────────────────────────────

  /** Cria Ticket + TicketBatch reais sob o evento. */
  async function seedTicketBatch(eventId: string) {
    const w = prisma.getWriteClient();
    const ticket = await w.ticket.create({
      data: { eventId, name: 'Ingresso Teste', modality: 'Corrida', isActive: true },
      select: { id: true },
    });
    const batch = await w.ticketBatch.create({
      data: { ticketId: ticket.id, quantity: 100, availableQuantity: 100, price: 10000 },
      select: { id: true },
    });
    return { ticketId: ticket.id, batchId: batch.id };
  }

  /**
   * Semeia um pedido PAGO completo e pronto para estorno.
   *
   * @returns ids relevantes para asserts (order, payment, registrations…).
   */
  async function seedPaidOrder(opts: {
    eventId: string;
    userId: string;
    couponId?: string | null;
    voucherId?: string | null;
    method?: PaymentMethod;
    /** quantos participantes/inscrições confirmadas criar. */
    seats?: number;
  }) {
    const w = prisma.getWriteClient();
    const { ticketId, batchId } = await seedTicketBatch(opts.eventId);
    const seats = opts.seats ?? 1;
    const method = opts.method ?? PaymentMethod.CREDIT_CARD;

    const finalAmount = 10000 * seats;
    const serviceFee = 1000 * seats;

    // pendingParticipants é lido por reverseSaleSideEffects (recompute do decremento do cupom).
    const pendingParticipants = Array.from({ length: seats }, (_, i) => ({
      name: `Participante ${i + 1}`,
      email: `p${i + 1}-${Date.now()}@teste.com`,
      birthDate: '2000-01-01',
    }));

    const order = await w.order.create({
      data: {
        userId: opts.userId,
        eventId: opts.eventId,
        totalAmount: finalAmount,
        serviceFee,
        discount: 0,
        finalAmount,
        organizerFeePercent: 10, // snapshot congelado → orgNet determinístico
        couponId: opts.couponId ?? null,
        voucherId: opts.voucherId ?? null,
        status: OrderStatus.PAID,
        pendingParticipants,
        pendingProducts: [],
      },
      select: { id: true },
    });

    // OrderReservedTicket: usado pelo recompute do cupom (quantity). 1 reserva cobrindo `seats` ingressos.
    await w.orderReservedTicket.create({
      data: {
        orderId: order.id,
        ticketId,
        batchId,
        quantity: seats,
        unitPrice: 10000,
      },
    });

    const payment = await w.payment.create({
      data: {
        orderId: order.id,
        userId: opts.userId,
        method,
        status: PaymentStatus.PAID,
        amount: finalAmount,
        transactionId: 'cielo-payment-123', // usado como cieloPaymentId (fallback de metadata)
        paymentDate: new Date(),
        metadata: {},
      },
      select: { id: true },
    });

    // Inscrições CONFIRMED (devem virar CANCELLED no estorno).
    const regIds: string[] = [];
    for (let i = 0; i < seats; i++) {
      const reg = await w.registration.create({
        data: {
          eventId: opts.eventId,
          orderId: order.id,
          userId: opts.userId,
          status: RegistrationStatus.CONFIRMED,
          termsAccepted: true,
          rulesAccepted: true,
        },
        select: { id: true },
      });
      regIds.push(reg.id);
    }

    return { orderId: order.id, paymentId: payment.id, regIds, ticketId, batchId };
  }

  /** Cria um cupom já com usageCount > 0 (simula que esta venda incrementou). */
  async function seedCoupon(eventId: string, usageCount: number) {
    const coupon = await prisma.getWriteClient().coupon.create({
      data: {
        eventId,
        code: `CUP-${Date.now()}`,
        couponType: 'QUANTITY',
        type: 'PERCENTAGE',
        value: 10,
        usageCount,
      },
      select: { id: true, usageCount: true },
    });
    return coupon;
  }

  /** Cria um voucher USED + reservado por este pedido (estado pós-venda). */
  async function seedUsedVoucher(eventId: string, userId: string, orderId: string) {
    const voucher = await prisma.getWriteClient().voucher.create({
      data: {
        eventId,
        name: 'Lote Voucher Teste',
        code: `VCH-${Date.now()}`,
        status: 'USED',
        usedAt: new Date(),
        usedBy: userId,
        reservedByOrderId: orderId,
        reservedUntil: new Date(Date.now() + 60_000),
      },
      select: { id: true },
    });
    return voucher;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Cenários
  // ───────────────────────────────────────────────────────────────────────────

  it('estorno bem-sucedido: pagamento vira REFUNDED, pedido CANCELLED e inscrições canceladas', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const { orderId, paymentId, regIds } = await seedPaidOrder({
      eventId,
      userId: adminUserId,
      seats: 2,
    });

    const res = await service.refundOrder({
      orderId,
      adminUserId,
      reason: 'Cliente desistiu',
    });

    // Cielo foi chamada com o transactionId (fallback de cieloPaymentId), estorno total (sem amount).
    expect(cieloMock.cancelPayment).toHaveBeenCalledTimes(1);
    expect(cieloMock.cancelPayment).toHaveBeenCalledWith('cielo-payment-123');
    expect(res.data.cieloStatus).toBe('Voided');
    expect(res.data.pendingConfirmation).toBe(false);

    // Pagamento → REFUNDED, com metadata de auditoria do estorno.
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(payment?.status).toBe(PaymentStatus.REFUNDED);
    const meta = payment?.metadata as Record<string, unknown>;
    expect(meta.refundType).toBe('REFUND');
    expect(meta.refundReason).toBe('Cliente desistiu');
    expect(meta.refundedByUserId).toBe(adminUserId);
    expect(typeof meta.refundedAt).toBe('string');

    // Pedido → CANCELLED (NÃO existe OrderStatus.REFUNDED no schema; quem fica REFUNDED é o pagamento).
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe(OrderStatus.CANCELLED);
    expect(order?.cancelledAt).not.toBeNull();
    expect(order?.cancelledReason).toContain('Estorno via Cielo');

    // Inscrições confirmadas → CANCELLED.
    const regs = await prisma.registration.findMany({ where: { id: { in: regIds } } });
    expect(regs).toHaveLength(2);
    expect(regs.every((r) => r.status === RegistrationStatus.CANCELLED)).toBe(true);
  });

  it('cupom: usageCount é decrementado ao estornar (QUANTITY → −1)', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const coupon = await seedCoupon(eventId, 3); // 3 usos antes do estorno
    const { orderId } = await seedPaidOrder({
      eventId,
      userId: adminUserId,
      couponId: coupon.id,
      seats: 2, // cupom QUANTITY decrementa 1 independentemente da qtd de ingressos
    });

    await service.refundOrder({ orderId, adminUserId, reason: 'Teste cupom' });

    const after = await prisma.coupon.findUnique({ where: { id: coupon.id } });
    expect(after?.usageCount).toBe(2); // 3 → 2 (QUANTITY = −1)
  });

  it('voucher: volta de USED para ACTIVE e a reserva é zerada', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    // O voucher precisa apontar para o orderId; criamos o pedido primeiro sem voucher e
    // depois o voucher, então linkamos no order (espelha o estado real pós-venda).
    const seeded = await seedPaidOrder({ eventId, userId: adminUserId, seats: 1 });
    const voucher = await seedUsedVoucher(eventId, adminUserId, seeded.orderId);
    await prisma.getWriteClient().order.update({
      where: { id: seeded.orderId },
      data: { voucherId: voucher.id },
    });

    await service.refundOrder({
      orderId: seeded.orderId,
      adminUserId,
      reason: 'Teste voucher',
    });

    const after = await prisma.voucher.findUnique({ where: { id: voucher.id } });
    expect(after?.status).toBe('ACTIVE');
    expect(after?.usedAt).toBeNull();
    expect(after?.usedBy).toBeNull();
    expect(after?.reservedByOrderId).toBeNull();
    expect(after?.reservedUntil).toBeNull();
  });

  it('registra log de auditoria ORDER_REFUND na organização do evento', async () => {
    const { adminUserId, eventId, organizationId } = await seedOrgUserEvent(prisma);
    const { orderId, paymentId } = await seedPaidOrder({
      eventId,
      userId: adminUserId,
      seats: 1,
    });

    await service.refundOrder({
      orderId,
      adminUserId,
      reason: 'Auditoria',
      ip: '203.0.113.7',
    });

    const logs = await prisma.organizationAuditLog.findMany({
      where: { organizationId, action: 'ORDER_REFUND' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorUserId).toBe(adminUserId);
    expect(logs[0].ip).toBe('203.0.113.7');
    const logMeta = logs[0].metadata as Record<string, unknown>;
    expect(logMeta.orderId).toBe(orderId);
    expect(logMeta.paymentId).toBe(paymentId);
    expect(logMeta.reason).toBe('Auditoria');
  });

  it('estorno PENDING da Cielo: marca pendingConfirmation e ainda aplica efeitos otimisticamente', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const { orderId, paymentId } = await seedPaidOrder({
      eventId,
      userId: adminUserId,
      seats: 1,
    });

    cieloMock.cancelPayment.mockResolvedValueOnce({
      success: true,
      paymentId: 'cielo-void-id',
      cieloStatus: 'Pending',
    });

    const res = await service.refundOrder({ orderId, adminUserId, reason: 'Pendente' });

    expect(res.data.pendingConfirmation).toBe(true);
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(payment?.status).toBe(PaymentStatus.REFUNDED); // efeito aplicado otimisticamente
    const meta = payment?.metadata as Record<string, unknown>;
    expect(meta.refundPendingConfirmation).toBe(true);
  });

  it('guard: não estorna pedido que não está PAID (lança ORDER_NOT_PAID e não chama a Cielo)', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const { orderId } = await seedPaidOrder({ eventId, userId: adminUserId, seats: 1 });
    // Coloca o pedido em CANCELLED → fora do estado estornável.
    await prisma.getWriteClient().order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED },
    });

    await expect(
      service.refundOrder({ orderId, adminUserId, reason: 'Inválido' }),
    ).rejects.toThrow(ConflictException);

    expect(cieloMock.cancelPayment).not.toHaveBeenCalled();
  });

  it('guard: pedido inexistente lança NotFound e não chama a Cielo', async () => {
    const { adminUserId } = await seedOrgUserEvent(prisma);
    const fakeOrderId = '00000000-0000-0000-0000-000000000000';

    await expect(
      service.refundOrder({ orderId: fakeOrderId, adminUserId, reason: 'Inexistente' }),
    ).rejects.toThrow(/não encontrado|ORDER_NOT_FOUND/i);

    expect(cieloMock.cancelPayment).not.toHaveBeenCalled();
  });

  it('idempotência: segunda chamada vira no-op nos efeitos (pagamento já REFUNDED)', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const coupon = await seedCoupon(eventId, 3);
    const { orderId } = await seedPaidOrder({
      eventId,
      userId: adminUserId,
      couponId: coupon.id,
      seats: 1,
    });

    await service.refundOrder({ orderId, adminUserId, reason: 'Primeiro' });

    // Segunda chamada: o pedido já não está PAID → guard ORDER_NOT_PAID. O cupom NÃO é
    // decrementado de novo (continua no valor pós-primeiro estorno).
    await expect(
      service.refundOrder({ orderId, adminUserId, reason: 'Segundo' }),
    ).rejects.toThrow(ConflictException);

    const after = await prisma.coupon.findUnique({ where: { id: coupon.id } });
    expect(after?.usageCount).toBe(2); // 3 → 2 (uma única vez), não 1
  });
});
