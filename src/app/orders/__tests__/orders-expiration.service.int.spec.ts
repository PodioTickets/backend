/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: expiração automática de pedidos (o "cron" que roda a cada 30s).
 *
 *  EM RESUMO:
 *    Quando alguém reserva ingressos mas NÃO paga dentro do prazo, o pedido "vence"
 *    (status PENDING + `expiresAt` no passado). Um serviço periódico
 *    (`OrdersExpirationService`) varre esses pedidos vencidos e os limpa, devolvendo
 *    o que estava preso:
 *      • O ESTOQUE volta para o lote (`TicketBatch.availableQuantity`).
 *      • As inscrições PENDING daquele pedido viram CANCELLED (ou somem junto com o pedido).
 *      • A RESERVA do voucher é LIBERADA (`Voucher.reservedByOrderId` volta a NULL),
 *        para que o voucher possa ser usado em outra compra.
 *
 *    DUAS REGRAS DE LIMPEZA, dependendo de quão longe o comprador chegou:
 *      • Se o comprador JÁ informou endereço de cobrança (`billingPostalCode` preenchido),
 *        o pedido é MANTIDO como histórico, virando CANCELLED (motivo EXPIRED).
 *      • Se NUNCA chegou no endereço, o pedido é simplesmente DELETADO (cascade leva
 *        inscrições e reservas de ingresso junto).
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Pedido PENDING vencido COM endereço → vira CANCELLED + estoque restaurado +
 *      inscrição CANCELLED + voucher liberado.
 *    • Pedido PENDING vencido SEM endereço → é DELETADO + estoque restaurado +
 *      voucher liberado (inscrição some por cascade).
 *    • Pedido PENDING que AINDA NÃO venceu → fica intacto (estoque/voucher preservados).
 *    • Pedido já PAID → fica intacto (o cron nunca mexe em pedido pago).
 *
 *  COMO CONFERIMOS:
 *    Teste DE VERDADE contra um banco de teste (descartável). Montamos no banco um
 *    pedido vencido completo (Order + OrderReservedTicket + TicketBatch + Ticket +
 *    Registration + Voucher reservado), chamamos o serviço de expiração e conferimos
 *    o resultado LENDO o banco de volta. Nada é "de faz-de-conta" — só o banco é
 *    separado e limpo antes de cada cenário.
 *
 *  PREMISSAS / NOTAS PARA QUEM FOR RODAR:
 *    • O cron real (`handleExpiredOrders`) apenas delega para
 *      `OrdersService.cancelExpiredOrders()`. Como `cancelExpiredOrders` só usa o
 *      `prisma`, instanciamos o `OrdersService` REAL com o prisma de teste e STUBS
 *      vazios para as demais dependências (Cielo/Email/Pdf/Redis/Finalization) —
 *      nenhuma delas é tocada neste fluxo. Em seguida embrulhamos no
 *      `OrdersExpirationService` e exercitamos via `handleExpiredOrders()`, batendo
 *      no caminho de produção de ponta a ponta.
 *    • `expiresAt` é gravado no PASSADO para simular o vencimento; o "não vencido"
 *      usa um `expiresAt` bem no futuro.
 * ============================================================================
 */
import { OrdersExpirationService } from '../orders-expiration.service';
import { OrdersService } from '../orders.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  createTestPrisma,
  resetDb,
  seedOrgUserEvent,
} from '../../../common/testing/integration-db';

describe('OrdersExpirationService (integração, banco real)', () => {
  let prisma: PrismaService;
  let service: OrdersExpirationService;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();

    // `cancelExpiredOrders` só usa `this.prisma`. As demais deps não são exercitadas
    // neste fluxo → stubs vazios bastam (e mantêm o teste focado no comportamento real).
    const ordersService = new OrdersService(
      prisma,
      {} as any, // CieloService
      { enabled: false } as any, // MercadoPagoService (débito MP desligado no teste)
      {} as any, // OrdersRedisService
      {} as any, // EmailService
      {} as any, // TicketPdfService
      {} as any, // ReceiptPdfService
      {} as any, // OrderFinalizationService
      { record: () => {} } as any, // UserActivityService (telemetria — no-op no teste)
    );
    service = new OrdersExpirationService(ordersService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma); // banco limpo antes de cada cenário
  });

  // ── helpers de montagem (criam linhas REAIS no banco de teste) ──────────────

  /** Cria categoria + ticket + lote com estoque inicial; devolve os ids e o estoque. */
  const seedTicketWithBatch = async (
    eventId: string,
    opts: { quantity?: number; available?: number } = {},
  ) => {
    const w = prisma.getWriteClient();
    const quantity = opts.quantity ?? 10;
    const available = opts.available ?? quantity;

    const category = await w.ticketCategory.create({
      data: { eventId, name: 'Lote Único' },
      select: { id: true },
    });
    const ticket = await w.ticket.create({
      data: {
        eventId,
        categoryId: category.id,
        name: 'Ingresso',
        modality: 'Corrida',
      },
      select: { id: true },
    });
    const batch = await w.ticketBatch.create({
      data: {
        ticketId: ticket.id,
        quantity,
        availableQuantity: available,
        price: 5000,
      },
      select: { id: true, availableQuantity: true },
    });
    return { ticketId: ticket.id, batchId: batch.id, batchInitialAvailable: available };
  };

  /** Cria um voucher ACTIVE reservado por `orderId` (simula carrinho que segurava o voucher). */
  const seedReservedVoucher = async (
    eventId: string,
    orderId: string,
    reservedUntil: Date,
  ) => {
    const w = prisma.getWriteClient();
    const voucher = await w.voucher.create({
      data: {
        eventId,
        name: 'Voucher Teste',
        code: `VCH-${orderId.slice(0, 8)}`,
        status: 'ACTIVE' as any,
        reservedByOrderId: orderId,
        reservedUntil,
      },
      select: { id: true },
    });
    return voucher.id;
  };

  /**
   * Monta um pedido PENDING completo: Order + OrderReservedTicket + Registration PENDING.
   * `expiresAt` controla se está vencido; `withBilling` controla a regra CANCELLED-vs-DELETE.
   */
  const seedPendingOrder = async (params: {
    eventId: string;
    userId: string;
    ticketId: string;
    batchId: string;
    expiresAt: Date;
    quantity?: number;
    withBilling?: boolean;
    status?: 'PENDING' | 'PAID';
  }) => {
    const w = prisma.getWriteClient();
    const qty = params.quantity ?? 2;

    const order = await w.order.create({
      data: {
        userId: params.userId,
        eventId: params.eventId,
        status: (params.status ?? 'PENDING') as any,
        totalAmount: 10000,
        serviceFee: 0,
        discount: 0,
        finalAmount: 10000,
        expiresAt: params.expiresAt,
        reservedAt: new Date(),
        // Endereço de cobrança presente => regra CANCELLED; ausente => regra DELETE.
        billingPostalCode: params.withBilling ? '01001000' : null,
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

    await w.registration.create({
      data: {
        eventId: params.eventId,
        orderId: order.id,
        userId: params.userId,
        status: 'PENDING' as any,
      },
    });

    return { orderId: order.id, reservedQty: qty };
  };

  const past = () => new Date(Date.now() - 60 * 1000); // 1 min no passado
  const future = () => new Date(Date.now() + 60 * 60 * 1000); // 1h no futuro

  // ── cenários ────────────────────────────────────────────────────────────────

  it('pedido vencido COM endereço → vira CANCELLED (EXPIRED), restaura estoque, cancela inscrição e libera o voucher', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const { ticketId, batchId } = await seedTicketWithBatch(eventId, {
      quantity: 10,
      available: 8, // 2 já reservados por este pedido
    });
    const { orderId, reservedQty } = await seedPendingOrder({
      eventId,
      userId: adminUserId,
      ticketId,
      batchId,
      expiresAt: past(),
      quantity: 2,
      withBilling: true,
    });
    const voucherId = await seedReservedVoucher(eventId, orderId, future());

    const cancelled = await service.handleExpiredOrders();
    // o cron não retorna o número; conferimos os efeitos lendo o banco
    expect(cancelled).toBeUndefined();

    const order = await prisma.getWriteClient().order.findUnique({ where: { id: orderId } });
    expect(order).not.toBeNull(); // mantido como histórico
    expect(order?.status).toBe('CANCELLED');
    expect(order?.cancelledReason).toBe('EXPIRED');
    expect(order?.cancelledAt).not.toBeNull();

    // estoque devolvido (8 + 2 = 10), com teto na quantidade do lote
    const batch = await prisma.getWriteClient().ticketBatch.findUnique({ where: { id: batchId } });
    expect(batch?.availableQuantity).toBe(8 + reservedQty);

    // inscrição PENDING → CANCELLED
    const regs = await prisma.getWriteClient().registration.findMany({ where: { orderId } });
    expect(regs).toHaveLength(1);
    expect(regs[0].status).toBe('CANCELLED');

    // voucher liberado (reserva volta a NULL)
    const voucher = await prisma.getWriteClient().voucher.findUnique({ where: { id: voucherId } });
    expect(voucher?.reservedByOrderId).toBeNull();
    expect(voucher?.reservedUntil).toBeNull();
    expect(voucher?.status).toBe('ACTIVE'); // liberado, NÃO consumido
  });

  it('pedido vencido SEM endereço → é DELETADO, restaura estoque e libera o voucher (inscrição some por cascade)', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const { ticketId, batchId } = await seedTicketWithBatch(eventId, {
      quantity: 10,
      available: 7, // 3 reservados por este pedido
    });
    const { orderId, reservedQty } = await seedPendingOrder({
      eventId,
      userId: adminUserId,
      ticketId,
      batchId,
      expiresAt: past(),
      quantity: 3,
      withBilling: false,
    });
    const voucherId = await seedReservedVoucher(eventId, orderId, future());

    await service.handleExpiredOrders();

    // pedido deletado de verdade
    const order = await prisma.getWriteClient().order.findUnique({ where: { id: orderId } });
    expect(order).toBeNull();

    // reservas de ingresso e inscrições removidas por cascade
    const reserved = await prisma.getWriteClient().orderReservedTicket.findMany({ where: { orderId } });
    expect(reserved).toHaveLength(0);
    const regs = await prisma.getWriteClient().registration.findMany({ where: { orderId } });
    expect(regs).toHaveLength(0);

    // estoque devolvido (7 + 3 = 10)
    const batch = await prisma.getWriteClient().ticketBatch.findUnique({ where: { id: batchId } });
    expect(batch?.availableQuantity).toBe(7 + reservedQty);

    // voucher liberado ANTES do delete (não fica preso a pedido inexistente)
    const voucher = await prisma.getWriteClient().voucher.findUnique({ where: { id: voucherId } });
    expect(voucher?.reservedByOrderId).toBeNull();
    expect(voucher?.reservedUntil).toBeNull();
    expect(voucher?.status).toBe('ACTIVE');
  });

  it('pedido PENDING que AINDA NÃO venceu → fica INTACTO (estoque, inscrição e voucher preservados)', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const { ticketId, batchId } = await seedTicketWithBatch(eventId, {
      quantity: 10,
      available: 8,
    });
    const { orderId } = await seedPendingOrder({
      eventId,
      userId: adminUserId,
      ticketId,
      batchId,
      expiresAt: future(), // ainda válido
      quantity: 2,
      withBilling: true,
    });
    const voucherId = await seedReservedVoucher(eventId, orderId, future());

    await service.handleExpiredOrders();

    const order = await prisma.getWriteClient().order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('PENDING'); // intacto
    expect(order?.cancelledAt).toBeNull();

    const batch = await prisma.getWriteClient().ticketBatch.findUnique({ where: { id: batchId } });
    expect(batch?.availableQuantity).toBe(8); // estoque NÃO devolvido

    const regs = await prisma.getWriteClient().registration.findMany({ where: { orderId } });
    expect(regs[0].status).toBe('PENDING');

    const voucher = await prisma.getWriteClient().voucher.findUnique({ where: { id: voucherId } });
    expect(voucher?.reservedByOrderId).toBe(orderId); // reserva mantida
  });

  it('pedido já PAID (mesmo com expiresAt no passado) → fica INTACTO (o cron nunca mexe em pago)', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const { ticketId, batchId } = await seedTicketWithBatch(eventId, {
      quantity: 10,
      available: 8,
    });
    const { orderId } = await seedPendingOrder({
      eventId,
      userId: adminUserId,
      ticketId,
      batchId,
      expiresAt: past(), // venceu, mas já está PAGO
      quantity: 2,
      withBilling: true,
      status: 'PAID',
    });
    const voucherId = await seedReservedVoucher(eventId, orderId, future());

    await service.handleExpiredOrders();

    const order = await prisma.getWriteClient().order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('PAID'); // intacto
    expect(order?.cancelledAt).toBeNull();

    const batch = await prisma.getWriteClient().ticketBatch.findUnique({ where: { id: batchId } });
    expect(batch?.availableQuantity).toBe(8); // estoque NÃO mexido

    const voucher = await prisma.getWriteClient().voucher.findUnique({ where: { id: voucherId } });
    expect(voucher?.reservedByOrderId).toBe(orderId); // reserva intacta
  });

  it('lote de vencidos: cancela os 2 vencidos e preserva o não-vencido na mesma varredura', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const { ticketId, batchId } = await seedTicketWithBatch(eventId, {
      quantity: 10,
      available: 4, // 6 reservados no total entre os 3 pedidos (2+1+3)
    });

    const venc1 = await seedPendingOrder({
      eventId, userId: adminUserId, ticketId, batchId,
      expiresAt: past(), quantity: 2, withBilling: true,
    });
    const venc2 = await seedPendingOrder({
      eventId, userId: adminUserId, ticketId, batchId,
      expiresAt: past(), quantity: 1, withBilling: false,
    });
    const valido = await seedPendingOrder({
      eventId, userId: adminUserId, ticketId, batchId,
      expiresAt: future(), quantity: 3, withBilling: true,
    });

    await service.handleExpiredOrders();

    const o1 = await prisma.getWriteClient().order.findUnique({ where: { id: venc1.orderId } });
    expect(o1?.status).toBe('CANCELLED'); // com endereço → mantido CANCELLED

    const o2 = await prisma.getWriteClient().order.findUnique({ where: { id: venc2.orderId } });
    expect(o2).toBeNull(); // sem endereço → deletado

    const o3 = await prisma.getWriteClient().order.findUnique({ where: { id: valido.orderId } });
    expect(o3?.status).toBe('PENDING'); // não venceu → intacto

    // estoque devolvido só dos 2 vencidos: 4 + 2 + 1 = 7 (o do válido continua preso)
    const batch = await prisma.getWriteClient().ticketBatch.findUnique({ where: { id: batchId } });
    expect(batch?.availableQuantity).toBe(4 + 2 + 1);
  });

  // ── JANELA DE GRAÇA p/ pagamento EM ANDAMENTO (regressão 2026-06-04) ────────
  // Antes, o cron cancelava pedido expirado mesmo com Payment PENDING (PIX aguardando
  // webhook): estoque devolvido/revendido e o webhook tardio confirmava um pedido morto.
  describe('janela de graça para pagamento em andamento', () => {
    /** Payment com status e idade configuráveis, vinculado ao pedido. */
    const seedPayment = async (orderId: string, userId: string, status: 'PENDING' | 'FAILED') => {
      await prisma.getWriteClient().payment.create({
        data: {
          orderId,
          userId,
          method: 'PIX' as any,
          status: status as any,
          amount: 10000,
          transactionId: `tx-${orderId.slice(0, 8)}`,
          metadata: {},
        },
      });
    };

    it('expirado HÁ POUCO com Payment PENDING (PIX em voo) → NÃO cancela (graça de 2h)', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const { ticketId, batchId } = await seedTicketWithBatch(eventId, { quantity: 10, available: 8 });
      const { orderId } = await seedPendingOrder({
        eventId, userId: adminUserId, ticketId, batchId,
        expiresAt: new Date(Date.now() - 5 * 60 * 1000), // venceu há 5 min
        quantity: 2, withBilling: true,
      });
      await seedPayment(orderId, adminUserId, 'PENDING');

      await service.handleExpiredOrders();

      const order = await prisma.getWriteClient().order.findUnique({ where: { id: orderId } });
      expect(order?.status).toBe('PENDING'); // protegido pela graça
      const batch = await prisma.getWriteClient().ticketBatch.findUnique({ where: { id: batchId } });
      expect(batch?.availableQuantity).toBe(8); // estoque NÃO devolvido (evita revenda da vaga)
    });

    it('expirado ALÉM da graça (3h) com Payment PENDING → cancela normalmente', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const { ticketId, batchId } = await seedTicketWithBatch(eventId, { quantity: 10, available: 8 });
      const { orderId } = await seedPendingOrder({
        eventId, userId: adminUserId, ticketId, batchId,
        expiresAt: new Date(Date.now() - 3 * 60 * 60 * 1000), // venceu há 3h > graça de 2h
        quantity: 2, withBilling: true,
      });
      await seedPayment(orderId, adminUserId, 'PENDING');

      await service.handleExpiredOrders();

      const order = await prisma.getWriteClient().order.findUnique({ where: { id: orderId } });
      expect(order?.status).toBe('CANCELLED'); // graça vencida → expira
      const batch = await prisma.getWriteClient().ticketBatch.findUnique({ where: { id: batchId } });
      expect(batch?.availableQuantity).toBe(10); // estoque devolvido
    });

    it('Payment FAILED → SEM graça: expira no prazo normal', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const { ticketId, batchId } = await seedTicketWithBatch(eventId, { quantity: 10, available: 8 });
      const { orderId } = await seedPendingOrder({
        eventId, userId: adminUserId, ticketId, batchId,
        expiresAt: new Date(Date.now() - 5 * 60 * 1000), // venceu há 5 min
        quantity: 2, withBilling: true,
      });
      await seedPayment(orderId, adminUserId, 'FAILED');

      await service.handleExpiredOrders();

      const order = await prisma.getWriteClient().order.findUnique({ where: { id: orderId } });
      expect(order?.status).toBe('CANCELLED'); // tentativa falha não segura o pedido
    });
  });
});
