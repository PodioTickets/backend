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
});
