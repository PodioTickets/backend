import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { OrdersService } from '../orders.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrdersRedisService } from '../orders-redis.service';
import { CieloService } from '../../payments/cielo.service';

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
});
