import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { OrdersService } from '../orders.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrdersRedisService } from '../orders-redis.service';
import { CieloService } from '../../payments/cielo.service';
import { EmailService } from '../../../common/services/email.service';
import { TicketPdfService } from '../../../common/services/ticket-pdf.service';
import { OrderFinalizationService } from '../../payments/order-finalization.service';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeWriteClient(overrides: Record<string, any> = {}) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    order: { delete: jest.fn().mockResolvedValue({}) },
    registration: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };

  const w = {
    order: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    // isAdminUser() consulta user.findUnique (via getReadClient); default = não-admin.
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn().mockImplementation((fn: (tx: any) => any) => fn(tx)),
    _tx: tx,
    ...overrides,
  };

  return w;
}

// ─── setup ───────────────────────────────────────────────────────────────────

describe('OrdersService', () => {
  let service: OrdersService;
  let writeClient: ReturnType<typeof makeWriteClient>;

  const mockPrisma = {
    getWriteClient: jest.fn(),
    getReadClient: jest.fn(),
  };

  const mockCieloService = {
    createPixPayment: jest.fn(),
    createCreditCardPayment: jest.fn(),
  };

  const mockRedisService = {
    getIdempotencyResult: jest.fn(),
    setIdempotencyResult: jest.fn(),
    checkReserveRateLimit: jest.fn(),
  };

  // Deps adicionais do construtor (não exercitadas pelos testes atuais de cancel/etc).
  const mockEmailService = {};
  const mockTicketPdfService = {};
  const mockOrderFinalization = {
    finalizePaidOrder: jest.fn().mockResolvedValue([]),
    confirmAndFinalizeOrder: jest.fn().mockResolvedValue({ finalized: true, registrations: [] }),
    reverseSaleSideEffects: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    writeClient = makeWriteClient();
    mockPrisma.getWriteClient.mockReturnValue(writeClient);
    mockPrisma.getReadClient.mockReturnValue(writeClient);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CieloService, useValue: mockCieloService },
        { provide: OrdersRedisService, useValue: mockRedisService },
        { provide: EmailService, useValue: mockEmailService },
        { provide: TicketPdfService, useValue: mockTicketPdfService },
        { provide: OrderFinalizationService, useValue: mockOrderFinalization },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── cancelExpiredOrders ───────────────────────────────────────────────────

  describe('cancelExpiredOrders', () => {
    const reservedTickets = [
      { batchId: 'batch-1', quantity: 2 },
      { batchId: 'batch-2', quantity: 1 },
    ];

    describe('when no expired orders exist', () => {
      it('returns 0 without touching the database', async () => {
        writeClient.order.findMany.mockResolvedValue([]);

        const result = await service.cancelExpiredOrders();

        expect(result).toBe(0);
        expect(writeClient.$queryRaw).not.toHaveBeenCalled();
        expect(writeClient.$transaction).not.toHaveBeenCalled();
      });
    });

    describe('order without billing address (never reached billing step)', () => {
      const order = {
        id: 'order-no-billing',
        billingPostalCode: null,
        reservedTickets,
      };

      beforeEach(() => {
        writeClient.order.findMany.mockResolvedValue([order]);
      });

      it('deletes the order via transaction', async () => {
        const result = await service.cancelExpiredOrders();

        expect(result).toBe(1);
        expect(writeClient.$transaction).toHaveBeenCalledTimes(1);
        expect(writeClient._tx.order.delete).toHaveBeenCalledWith({
          where: { id: order.id },
        });
      });

      it('restores stock for each reserved ticket before deleting', async () => {
        await service.cancelExpiredOrders();

        expect(writeClient._tx.$executeRaw).toHaveBeenCalledTimes(
          reservedTickets.length,
        );
      });

      it('does NOT update order status to CANCELLED', async () => {
        await service.cancelExpiredOrders();

        expect(writeClient.$queryRaw).not.toHaveBeenCalled();
      });

      it('does NOT call registration.updateMany', async () => {
        await service.cancelExpiredOrders();

        expect(writeClient._tx.registration.updateMany).not.toHaveBeenCalled();
      });
    });

    describe('order with billing address (reached billing/payment step)', () => {
      const order = {
        id: 'order-with-billing',
        billingPostalCode: '01310-100',
        reservedTickets,
      };

      beforeEach(() => {
        writeClient.order.findMany.mockResolvedValue([order]);
        // Simulates the atomic UPDATE ... RETURNING id succeeding
        writeClient.$queryRaw.mockResolvedValue([{ id: order.id }]);
      });

      it('marks the order as CANCELLED (not deleted)', async () => {
        const result = await service.cancelExpiredOrders();

        expect(result).toBe(1);
        expect(writeClient.$queryRaw).toHaveBeenCalledTimes(1);
        expect(writeClient._tx.order.delete).not.toHaveBeenCalled();
      });

      it('restores stock and cancels registrations in a transaction', async () => {
        await service.cancelExpiredOrders();

        expect(writeClient.$transaction).toHaveBeenCalledTimes(1);
        expect(writeClient._tx.$executeRaw).toHaveBeenCalledTimes(
          reservedTickets.length,
        );
        expect(writeClient._tx.registration.updateMany).toHaveBeenCalledWith({
          where: { orderId: order.id, status: 'PENDING' },
          data: { status: 'CANCELLED' },
        });
      });

      it('skips stock restore if race condition wins (UPDATE returns 0 rows)', async () => {
        writeClient.$queryRaw.mockResolvedValue([]); // another process got there first

        const result = await service.cancelExpiredOrders();

        expect(result).toBe(0);
        expect(writeClient.$transaction).not.toHaveBeenCalled();
      });
    });

    describe('mixed batch (one with billing, one without)', () => {
      const orderNoBilling = {
        id: 'order-no-billing',
        billingPostalCode: null,
        reservedTickets: [{ batchId: 'batch-1', quantity: 3 }],
      };
      const orderWithBilling = {
        id: 'order-with-billing',
        billingPostalCode: '01310-100',
        reservedTickets: [{ batchId: 'batch-2', quantity: 1 }],
      };

      it('processes each order with the correct strategy', async () => {
        writeClient.order.findMany.mockResolvedValue([
          orderNoBilling,
          orderWithBilling,
        ]);
        writeClient.$queryRaw.mockResolvedValue([{ id: orderWithBilling.id }]);

        const result = await service.cancelExpiredOrders();

        expect(result).toBe(2);
        // no-billing → delete
        expect(writeClient._tx.order.delete).toHaveBeenCalledWith({
          where: { id: orderNoBilling.id },
        });
        // with-billing → cancel via queryRaw
        expect(writeClient.$queryRaw).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ── forceExpire ───────────────────────────────────────────────────────────

  describe('forceExpire', () => {
    const userId = 'user-123';
    const orderId = 'order-456';

    it('sets expiresAt to the past so the cron picks it up', async () => {
      writeClient.order.findUnique.mockResolvedValue({
        id: orderId,
        userId,
        status: 'PENDING',
      });

      const before = Date.now();
      await service.forceExpire(userId, orderId);
      const after = Date.now();

      const [call] = writeClient.order.update.mock.calls;
      const setDate: Date = call[0].data.expiresAt;
      expect(setDate.getTime()).toBeLessThan(before);
      expect(setDate.getTime()).toBeLessThan(after);
    });

    it('throws NotFoundException if order does not belong to user', async () => {
      writeClient.order.findUnique.mockResolvedValue({
        id: orderId,
        userId: 'other-user',
        status: 'PENDING',
      });

      await expect(service.forceExpire(userId, orderId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException if order not found', async () => {
      writeClient.order.findUnique.mockResolvedValue(null);

      await expect(service.forceExpire(userId, orderId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ConflictException if order is not PENDING', async () => {
      writeClient.order.findUnique.mockResolvedValue({
        id: orderId,
        userId,
        status: 'PAID',
      });

      await expect(service.forceExpire(userId, orderId)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // ── patchParticipants — sincronização bidirecional reserva ↔ participantes ───
  // Invariante exercitado: reservedTickets == placeholders PENDING == estoque retido.
  describe('patchParticipants (sync reserva ↔ participantes)', () => {
    const buyerId = 'buyer-1';
    const orderId = 'order-sync';

    const baseOrder = {
      id: orderId,
      userId: buyerId,
      status: 'PENDING',
      eventId: 'evt-1',
      couponId: null,
      voucherId: null,
      coupon: null,
      voucher: null,
      discount: 0,
      pendingProducts: null,
      reservedTickets: [],
      event: { eventDate: null },
    };

    const batchRows = [
      { id: 'batch-A', price: 10000, ticketId: 'tk-A', ticket: { name: '100 reais' } },
      { id: 'batch-B', price: 10000, ticketId: 'tk-B', ticket: { name: 'Outro' } },
    ];

    function buildClient(placeholderRegs: any[], acquireRows: any[] = [{ id: 'batch-x' }]) {
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        $queryRaw: jest.fn().mockResolvedValue(acquireRows),
        registration: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        orderReservedTicket: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        order: {
          update: jest.fn().mockImplementation(({ data }: any) => ({
            id: orderId,
            status: 'PENDING',
            reservedTickets: [],
            coupon: null,
            voucher: null,
            payment: null,
            event: null,
            ...data,
          })),
        },
      };
      const client: any = {
        order: { findUnique: jest.fn().mockResolvedValue(baseOrder) },
        user: { findUnique: jest.fn().mockResolvedValue(null) },
        registration: { findMany: jest.fn().mockResolvedValue(placeholderRegs) },
        ticketBatch: { findMany: jest.fn().mockResolvedValue(batchRows) },
        coupon: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn().mockImplementation((fn: (tx: any) => any) => fn(tx)),
        _tx: tx,
      };
      mockPrisma.getWriteClient.mockReturnValue(client);
      mockPrisma.getReadClient.mockReturnValue(client);
      return client;
    }

    const totalCreatedQty = (client: any) =>
      client._tx.orderReservedTicket.createMany.mock.calls[0][0].data.reduce(
        (s: number, r: any) => s + r.quantity,
        0,
      );

    it('encolhe: 2 reservados, 1 participante → libera 1 vaga e cancela 1 placeholder', async () => {
      const client = buildClient([
        { id: 'reg-1', status: 'PENDING', tickets: [{ ticketId: 'tk-A', batchId: 'batch-A' }] },
        { id: 'reg-2', status: 'PENDING', tickets: [{ ticketId: 'tk-B', batchId: 'batch-B' }] },
      ]);

      await service.patchParticipants(buyerId, orderId, {
        participants: [{ email: 'a@a.com' }],
      } as any);

      expect(client._tx.$executeRaw).toHaveBeenCalledTimes(1); // restaura estoque
      expect(client._tx.$queryRaw).not.toHaveBeenCalled(); // nada a adquirir
      expect(client._tx.registration.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['reg-2'] } }, data: { status: 'CANCELLED' } }),
      );
      expect(totalCreatedQty(client)).toBe(1);
    });

    it('cresce de volta: 1 PENDING + 1 CANCELLED, 2 participantes → re-adquire e reativa', async () => {
      const client = buildClient(
        [
          { id: 'reg-1', status: 'PENDING', tickets: [{ ticketId: 'tk-A', batchId: 'batch-A' }] },
          { id: 'reg-2', status: 'CANCELLED', tickets: [{ ticketId: 'tk-B', batchId: 'batch-B' }] },
        ],
        [{ id: 'batch-B' }], // aquisição atômica bem-sucedida
      );

      await service.patchParticipants(buyerId, orderId, {
        participants: [{ email: 'a@a.com' }, { email: 'b@b.com' }],
      } as any);

      expect(client._tx.$queryRaw).toHaveBeenCalledTimes(1); // re-adquire estoque
      expect(client._tx.$executeRaw).not.toHaveBeenCalled(); // nada a liberar
      expect(client._tx.registration.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['reg-2'] } }, data: { status: 'PENDING' } }),
      );
      expect(totalCreatedQty(client)).toBe(2);
    });

    it('excede o original: 3 participantes para 2 reservados → PARTICIPANTS_EXCEED_TICKETS', async () => {
      buildClient([
        { id: 'reg-1', status: 'PENDING', tickets: [{ ticketId: 'tk-A', batchId: 'batch-A' }] },
        { id: 'reg-2', status: 'PENDING', tickets: [{ ticketId: 'tk-B', batchId: 'batch-B' }] },
      ]);

      await expect(
        service.patchParticipants(buyerId, orderId, {
          participants: [{ email: 'a' }, { email: 'b' }, { email: 'c' }],
        } as any),
      ).rejects.toThrow(/excede os ingressos reservados/);
    });

    it('vaga esgotada ao crescer: aquisição atômica sem linha → SEAT_NO_LONGER_AVAILABLE', async () => {
      buildClient(
        [
          { id: 'reg-1', status: 'PENDING', tickets: [{ ticketId: 'tk-A', batchId: 'batch-A' }] },
          { id: 'reg-2', status: 'CANCELLED', tickets: [{ ticketId: 'tk-B', batchId: 'batch-B' }] },
        ],
        [], // estoque indisponível
      );

      await expect(
        service.patchParticipants(buyerId, orderId, {
          participants: [{ email: 'a' }, { email: 'b' }],
        } as any),
      ).rejects.toThrow(/não está mais disponível/);
    });
  });

  // ── patchCoupon — lista de documento validada POR PARTICIPANTE (não pelo comprador) ──
  describe('patchCoupon (cupom/voucher c/ lista de documento por participante)', () => {
    const buyerId = 'buyer-1';
    const orderId = 'order-doc';

    function buildClient({ order, coupon = null, voucher = null }: any) {
      const captured: any = {};
      const client: any = {
        order: {
          findUnique: jest.fn().mockResolvedValue(order),
          update: jest.fn().mockImplementation(({ data }: any) => {
            captured.update = data;
            return {
              ...order,
              ...data,
              coupon: data.couponId ? coupon : null,
              voucher: data.voucherId ? voucher : null,
              reservedTickets: order.reservedTickets,
              pendingParticipants: order.pendingParticipants,
              status: 'PENDING',
            };
          }),
        },
        user: { findUnique: jest.fn().mockResolvedValue(null) },
        voucher: { findUnique: jest.fn().mockResolvedValue(voucher) },
        coupon: {
          findFirst: jest.fn().mockResolvedValue(coupon),
          findUnique: jest.fn().mockResolvedValue(coupon),
        },
        $transaction: jest.fn().mockImplementation((fn: any) => fn(client)),
        _captured: captured,
      };
      mockPrisma.getReadClient.mockReturnValue(client);
      mockPrisma.getWriteClient.mockReturnValue(client);
      return client;
    }

    // participante 0 elegível (CPF na lista), participante 1 NÃO elegível
    const participants = [
      { documentType: 'CPF', documentNumber: '11111111111' },
      { documentType: 'CPF', documentNumber: '22222222222' },
    ];

    it('CUPOM: aplica o desconto só nos ingressos dos participantes elegíveis', async () => {
      const order = {
        id: orderId,
        userId: buyerId,
        status: 'PENDING',
        eventId: 'evt-1',
        totalAmount: 20000,
        couponId: null,
        voucherId: null,
        coupon: null,
        voucher: null,
        event: { participantFeePercent: 0 },
        reservedTickets: [{ ticketId: 'tk-A', quantity: 2, unitPrice: 10000 }],
        pendingParticipants: participants,
      };
      const coupon = {
        id: 'cpn-1',
        code: 'DESC50',
        status: 'ACTIVE',
        couponType: 'DISCOUNT',
        type: 'PERCENTAGE',
        value: 50,
        appliesTo: 'all',
        maxUsage: null,
        usageCount: 0,
        applyToProducts: false,
        cpfListStatus: 'ENABLED',
        documentList: [{ type: 'CPF', numberClean: '11111111111' }],
        cpfList: null,
      };
      const client = buildClient({ order, coupon });

      const res: any = await service.patchCoupon(buyerId, orderId, { couponCode: 'DESC50' } as any);

      // 1 elegível de 2 ingressos @100 → 50% sobre 1 ingresso = 5000 (não 10000).
      expect(client._captured.update.discount).toBe(5000);
      expect(client._captured.update.couponId).toBe('cpn-1');
      expect(res.appliedDiscount.discount).toBe(5000);
    });

    it('CUPOM: nenhum participante elegível → rejeição soft (couponRejected), pedido inalterado', async () => {
      const order = {
        id: orderId,
        userId: buyerId,
        status: 'PENDING',
        eventId: 'evt-1',
        totalAmount: 20000,
        couponId: null,
        voucherId: null,
        coupon: null,
        voucher: null,
        event: { participantFeePercent: 0 },
        reservedTickets: [{ ticketId: 'tk-A', quantity: 2, unitPrice: 10000 }],
        pendingParticipants: [{ documentType: 'CPF', documentNumber: '99999999999' }],
      };
      const coupon = {
        id: 'cpn-1', code: 'DESC50', status: 'ACTIVE', couponType: 'DISCOUNT',
        type: 'PERCENTAGE', value: 50, appliesTo: 'all', maxUsage: null, usageCount: 0,
        applyToProducts: false, cpfListStatus: 'ENABLED',
        documentList: [{ type: 'CPF', numberClean: '11111111111' }], cpfList: null,
      };
      const client = buildClient({ order, coupon });

      const res: any = await service.patchCoupon(buyerId, orderId, { couponCode: 'DESC50' } as any);

      expect(res.couponRejected?.code).toBe('COUPON_CPF_RESTRICTED');
      expect(client._captured.update).toBeUndefined(); // pedido NÃO foi alterado
    });

    it('VOUCHER: o ingresso grátis cai no participante elegível (não no mais caro)', async () => {
      const order = {
        id: orderId,
        userId: buyerId,
        status: 'PENDING',
        eventId: 'evt-1',
        totalAmount: 15000,
        couponId: null,
        voucherId: null,
        coupon: null,
        voucher: null,
        event: { participantFeePercent: 0 },
        // slot0 = ticket A @5000 (participante 0, ELEGÍVEL); slot1 = ticket B @10000 (não elegível)
        reservedTickets: [
          { ticketId: 'tk-A', quantity: 1, unitPrice: 5000 },
          { ticketId: 'tk-B', quantity: 1, unitPrice: 10000 },
        ],
        pendingParticipants: participants,
      };
      const voucher = {
        id: 'vch-1', code: 'FREE', eventId: 'evt-1', status: 'ACTIVE', expiryDate: null,
        appliesTo: 'all', applyToProducts: false, cpfListStatus: 'ENABLED',
        documentList: [{ type: 'CPF', numberClean: '11111111111' }], cpfList: null,
      };
      const client = buildClient({ order, voucher });

      const res: any = await service.patchCoupon(buyerId, orderId, { voucherCode: 'FREE' } as any);

      // Cobre o ingresso do participante elegível (5000), NÃO o mais caro do pedido (10000).
      expect(client._captured.update.discount).toBe(5000);
      expect(client._captured.update.voucherId).toBe('vch-1');
      expect(res.appliedDiscount.discount).toBe(5000);
    });

    // ── fluxos manuais (sem lista de documento) ──────────────────────────────
    const plainOrder = (over: any = {}) => ({
      id: orderId, userId: buyerId, status: 'PENDING', eventId: 'evt-1', totalAmount: 20000,
      couponId: null, voucherId: null, coupon: null, voucher: null, event: { participantFeePercent: 0 },
      reservedTickets: [{ ticketId: 'tk-A', quantity: 2, unitPrice: 10000 }], pendingParticipants: [], ...over,
    });
    const plainCoupon = (over: any = {}) => ({
      id: 'd1', code: 'OFF50', status: 'ACTIVE', couponType: 'DISCOUNT', type: 'PERCENTAGE', value: 50,
      appliesTo: 'all', maxUsage: null, usageCount: 0, applyToProducts: false, cpfListStatus: 'DISABLED',
      documentList: null, cpfList: null, minCartValue: null, expiryDate: null, ...over,
    });

    it('CUPOM DISCOUNT PERCENTAGE (sem lista): aplica em todos os ingressos aplicáveis', async () => {
      const client = buildClient({ order: plainOrder(), coupon: plainCoupon() });
      await service.patchCoupon(buyerId, orderId, { couponCode: 'OFF50' } as any);
      expect(client._captured.update.discount).toBe(10000); // 50% de 2 ingressos
      expect(client._captured.update.couponId).toBe('d1');
    });

    it('CUPOM DISCOUNT FIXED: valor por uso, capado no subtotal', async () => {
      const client = buildClient({ order: plainOrder(), coupon: plainCoupon({ type: 'FIXED', value: 3000 }) });
      await service.patchCoupon(buyerId, orderId, { couponCode: 'OFF50' } as any);
      expect(client._captured.update.discount).toBe(6000); // 3000 × 2
    });

    it('CUPOM expirado → rejeição soft (COUPON_EXPIRED), pedido inalterado', async () => {
      const client = buildClient({ order: plainOrder(), coupon: plainCoupon({ expiryDate: new Date('2020-01-01') }) });
      const res: any = await service.patchCoupon(buyerId, orderId, { couponCode: 'OFF50' } as any);
      expect(res.couponRejected?.code).toBe('COUPON_EXPIRED');
      expect(client._captured.update).toBeUndefined();
    });

    it('CUPOM abaixo do valor mínimo → rejeição soft (COUPON_MIN_VALUE)', async () => {
      const client = buildClient({ order: plainOrder(), coupon: plainCoupon({ minCartValue: 50000 }) });
      const res: any = await service.patchCoupon(buyerId, orderId, { couponCode: 'OFF50' } as any);
      expect(res.couponRejected?.code).toBe('COUPON_MIN_VALUE');
      expect(client._captured.update).toBeUndefined();
    });

    it('CUPOM inexistente → rejeição soft (COUPON_NOT_FOUND)', async () => {
      const client = buildClient({ order: plainOrder(), coupon: null, voucher: null });
      const res: any = await service.patchCoupon(buyerId, orderId, { couponCode: 'NOPE' } as any);
      expect(res.couponRejected?.code).toBe('COUPON_NOT_FOUND');
      expect(client._captured.update).toBeUndefined();
    });

    it('cupom + voucher juntos → erro DISCOUNT_CONFLICT (hard)', async () => {
      buildClient({ order: plainOrder() });
      await expect(
        service.patchCoupon(buyerId, orderId, { couponCode: 'OFF50', voucherCode: 'FREE' } as any),
      ).rejects.toThrow(/cupom e voucher ao mesmo tempo/);
    });

    it('sem código → remove cupom/voucher (discount 0)', async () => {
      const client = buildClient({ order: plainOrder({ couponId: 'd1', discount: 10000 }) });
      await service.patchCoupon(buyerId, orderId, {} as any);
      expect(client._captured.update.discount).toBe(0);
      expect(client._captured.update.couponId).toBeNull();
      expect(client._captured.update.voucherId).toBeNull();
    });
  });

  // ── findOrder — cupom AGE auto-aplicado respeita maxUsage na re-derivação (orderShape) ──
  describe('findOrder (cupom AGE respeita maxUsage)', () => {
    const buyerId = 'buyer-1';
    const orderId = 'order-age';

    it('maxUsage=1 + 2 ingressos elegíveis → desconto capado em 1 ingresso (não 2)', async () => {
      const order = {
        id: orderId,
        userId: buyerId,
        eventId: 'evt-1',
        status: 'PENDING',
        totalAmount: 20000,
        // discount DEFASADO (simula o bug: persistido como 2 ingressos) — orderShape deve recapar.
        discount: 10000,
        serviceFee: 0,
        finalAmount: 10000,
        event: { participantFeePercent: 0, eventDate: new Date('2026-12-01') },
        coupon: {
          id: 'age-1', code: null, couponType: 'AGE', type: 'PERCENTAGE', value: 50,
          appliesTo: 'all', minAge: 0, maxAge: 200, applyToProducts: false,
          cpfListStatus: 'DISABLED', documentList: null, cpfList: null,
          maxUsage: 1, usageCount: 0,
        },
        voucher: null,
        payment: null,
        reservedTickets: [{ ticketId: 'tk-A', quantity: 2, unitPrice: 10000 }],
        pendingParticipants: [{ birthDate: '1990-01-01' }, { birthDate: '1992-01-01' }],
      };
      const client: any = {
        order: { findUnique: jest.fn().mockResolvedValue(order) },
        user: { findUnique: jest.fn().mockResolvedValue(null) },
      };
      mockPrisma.getReadClient.mockReturnValue(client);
      mockPrisma.getWriteClient.mockReturnValue(client);

      const res: any = await service.findOrder(buyerId, orderId);

      // 50% sobre 1 ingresso (@100) = 5000 — capado por maxUsage=1, mesmo com 2 elegíveis.
      expect(res.discount).toBe(5000);
      // Só 1 unidade recebe desconto.
      const discountedUnits = (res.reservedTickets as any[]).filter((u: any) => u.couponApplied);
      expect(discountedUnits.length).toBe(1);
    });
  });

  // ── evaluateAutoCoupons — auto-cupons QUANTITY/AGE (método privado, via `as any`) ──
  describe('evaluateAutoCoupons (auto QUANTITY/AGE)', () => {
    // findMany = candidatos da branch (b); findUnique = cupom existente (branch a/c).
    function buildAutoClient(found: any[], existing: any = null) {
      const client: any = {
        coupon: {
          findMany: jest.fn().mockResolvedValue(found),
          findUnique: jest.fn().mockResolvedValue(existing),
        },
      };
      mockPrisma.getReadClient.mockReturnValue(client);
      mockPrisma.getWriteClient.mockReturnValue(client);
      return client;
    }
    const order = (over: any = {}) => ({
      eventId: 'evt-1', couponId: null, voucherId: null, coupon: null, voucher: null,
      discount: 0, event: { eventDate: '2026-12-01' }, ...over,
    });
    const tickets2 = [{ ticketId: 'tk-A', quantity: 2, unitPrice: 10000 }];
    const call = (o: any, parts: any[], rt: any[], opts?: any) =>
      (service as any).evaluateAutoCoupons(o, parts, rt, rt.reduce((s: number, t: any) => s + t.unitPrice * t.quantity, 0), 0, opts);

    it('QUANTITY: minQuantity atingido → aplica (PERCENTAGE sobre o subtotal)', async () => {
      buildAutoClient([{ id: 'q1', couponType: 'QUANTITY', type: 'PERCENTAGE', value: 10, appliesTo: null, minQuantity: 2, maxUsage: null, usageCount: 0, minCartValue: null, applyToProducts: false }]);
      const res = await call(order(), [{}, {}], tickets2);
      expect(res.autoCouponId).toBe('q1');
      expect(res.newDiscount).toBe(2000); // 10% de 20000
    });

    it('QUANTITY: abaixo do minQuantity → NÃO aplica', async () => {
      buildAutoClient([{ id: 'q1', couponType: 'QUANTITY', type: 'PERCENTAGE', value: 10, appliesTo: null, minQuantity: 5, maxUsage: null, usageCount: 0, minCartValue: null, applyToProducts: false }]);
      const res = await call(order(), [{}, {}], tickets2);
      expect(res.autoCouponId).toBeUndefined();
      expect(res.newDiscount).toBe(0);
    });

    it('QUANTITY: esgotado (usageCount >= maxUsage) → NÃO aplica', async () => {
      buildAutoClient([{ id: 'q1', couponType: 'QUANTITY', type: 'PERCENTAGE', value: 10, appliesTo: null, minQuantity: 2, maxUsage: 1, usageCount: 1, minCartValue: null, applyToProducts: false }]);
      const res = await call(order(), [{}, {}], tickets2);
      expect(res.autoCouponId).toBeUndefined();
    });

    it('QUANTITY: minCartValue não atingido → NÃO aplica', async () => {
      buildAutoClient([{ id: 'q1', couponType: 'QUANTITY', type: 'PERCENTAGE', value: 10, appliesTo: null, minQuantity: 2, maxUsage: null, usageCount: 0, minCartValue: 50000, applyToProducts: false }]);
      const res = await call(order(), [{}, {}], tickets2);
      expect(res.autoCouponId).toBeUndefined();
    });

    it('QUANTITY com cpfListStatus ENABLED → IGNORA a lista (aplica por quantidade, sem cpf)', async () => {
      buildAutoClient([{ id: 'q1', couponType: 'QUANTITY', type: 'PERCENTAGE', value: 10, appliesTo: null, minQuantity: 2, maxUsage: null, usageCount: 0, minCartValue: null, applyToProducts: false, cpfListStatus: 'ENABLED', documentList: [{ type: 'CPF', numberClean: '11111111111' }], cpfList: null }]);
      // participantes sem documento na lista — QUANTITY aplica mesmo assim
      const res = await call(order(), [{ documentType: 'CPF', documentNumber: '99999999999' }, {}], tickets2);
      expect(res.autoCouponId).toBe('q1');
      expect(res.newDiscount).toBe(2000); // 10% de 20000, sem corte por cpf
    });

    it('QUANTITY FIXED: valor por unidade aplicável, capado no subtotal', async () => {
      buildAutoClient([{ id: 'q1', couponType: 'QUANTITY', type: 'FIXED', value: 3000, appliesTo: null, minQuantity: 2, maxUsage: null, usageCount: 0, minCartValue: null, applyToProducts: false }]);
      const res = await call(order(), [{}, {}], tickets2);
      expect(res.newDiscount).toBe(6000); // 3000 × 2
    });

    it('AGE: participantes na faixa → aplica capado por maxUsage, com qualifyingSlots', async () => {
      buildAutoClient([{ id: 'age1', couponType: 'AGE', type: 'PERCENTAGE', value: 50, appliesTo: null, minAge: 0, maxAge: 200, maxUsage: 1, usageCount: 0, minCartValue: null, applyToProducts: false }]);
      const res = await call(order(), [{ birthDate: '1990-01-01' }, { birthDate: '1991-01-01' }], tickets2);
      expect(res.autoCouponId).toBe('age1');
      expect(res.autoEffectiveUsage).toBe(1); // capado por maxUsage=1
      expect(res.newDiscount).toBe(5000); // 50% de 1 ingresso
      expect(res.ageQualifyingSlots).toEqual([0, 1]);
    });

    it('AGE: ninguém na faixa → NÃO aplica', async () => {
      buildAutoClient([{ id: 'age1', couponType: 'AGE', type: 'PERCENTAGE', value: 50, appliesTo: null, minAge: 60, maxAge: 70, maxUsage: null, usageCount: 0, minCartValue: null, applyToProducts: false }]);
      const res = await call(order(), [{ birthDate: '2000-01-01' }], tickets2);
      expect(res.autoCouponId).toBeUndefined();
    });

    it('AGE existente reavaliado: participantes saíram da faixa → marca remoção', async () => {
      const existing = { id: 'age1', couponType: 'AGE', type: 'PERCENTAGE', value: 50, minAge: 60, maxAge: 70, maxUsage: null, usageCount: 0, appliesTo: null, applyToProducts: false };
      buildAutoClient([], existing);
      const res = await call(order({ couponId: 'age1', coupon: existing }), [{ birthDate: '2000-01-01' }], tickets2);
      expect(res.shouldRemoveAgeCoupon).toBe(true);
      expect(res.newDiscount).toBe(0);
    });

    it('QUANTITY existente: participantes abaixo do minQuantity → marca remoção', async () => {
      const existing = { couponType: 'QUANTITY', minQuantity: 3 };
      buildAutoClient([], existing);
      const res = await call(order({ couponId: 'q1', coupon: { couponType: 'QUANTITY' } }), [{}], tickets2);
      expect(res.shouldRemoveQuantityCoupon).toBe(true);
    });

    it('restrição autoApplyCouponTypes: a query de candidatos pede só os tipos informados', async () => {
      const client = buildAutoClient([]);
      await call(order(), [{}, {}], tickets2, { autoApplyCouponTypes: ['AGE'] });
      const whereArg = client.coupon.findMany.mock.calls[0][0].where;
      expect(whereArg.couponType).toEqual({ in: ['AGE'] });
    });
  });

  // ── pay — cupom no PAGAMENTO (caminho de pedido grátis: cupom 100% → pula gateway) ──
  describe('pay (cupom no pagamento — pedido grátis)', () => {
    const buyerId = 'buyer-1';
    const orderId = 'order-pay';

    it('cupom 100% → discount = subtotal, finalTotal 0, pedido PAID', async () => {
      const order = {
        id: orderId, userId: buyerId, status: 'PENDING', eventId: 'evt-1',
        expiresAt: null, totalAmount: 10000,
        billingPostalCode: '11850000', billingStreet: 'Rua X', billingCity: 'Maceió',
        coupon: null, voucher: null, couponId: null, voucherId: null,
        event: { participantFeePercent: 0, organizerFeePercent: 0 },
        reservedTickets: [{ ticketId: 'tk-A', quantity: 1, unitPrice: 10000 }],
        pendingParticipants: [{ email: 'a@a.com', documentType: 'CPF', documentNumber: '11111111111' }],
        pendingProducts: null,
      };
      const coupon100 = { id: 'c100', code: 'FREE100', status: 'ACTIVE', couponType: 'DISCOUNT', type: 'PERCENTAGE', value: 100, appliesTo: 'all', deletedAt: null, maxUsage: null, usageCount: 0, applyToProducts: false, cpfListStatus: 'DISABLED', documentList: null, cpfList: null, expiryDate: null };

      const tx: any = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: orderId }]), // guard PENDING→PAID
        order: { update: jest.fn().mockResolvedValue({}) },
        payment: { upsert: jest.fn().mockResolvedValue({}) },
      };
      const client: any = {
        order: { findUnique: jest.fn().mockResolvedValue(order) },
        user: { findUnique: jest.fn().mockResolvedValue({ firstName: 'A', lastName: 'B', email: 'a@a.com' }) },
        coupon: { findFirst: jest.fn().mockResolvedValue(coupon100) },
        voucher: { findUnique: jest.fn().mockResolvedValue(null) },
        event: { findUnique: jest.fn().mockResolvedValue(null) }, // snapshotEvent null → pula e-mail
        $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
      };
      mockPrisma.getReadClient.mockReturnValue(client);
      mockPrisma.getWriteClient.mockReturnValue(client);
      mockRedisService.getIdempotencyResult.mockResolvedValue(null);
      mockOrderFinalization.finalizePaidOrder.mockResolvedValue([{ id: 'reg-1', status: 'CONFIRMED', qrCode: 'q' }]);

      const res: any = await service.pay(buyerId, orderId, undefined, { method: 'PIX', couponCode: 'FREE100' } as any);

      expect(res.status).toBe('PAID');
      expect(res.pricing.discount).toBe(10000); // 100% do ingresso
      expect(res.pricing.finalTotal).toBe(0);
      // grava o snapshot financeiro coerente na tx
      expect(tx.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ discount: 10000, finalAmount: 0, couponId: 'c100' }) }),
      );
    });
  });
});
