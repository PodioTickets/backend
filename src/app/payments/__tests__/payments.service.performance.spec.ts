import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsService } from '../payments.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { CieloService } from '../cielo.service';
import { PaymentMethod, PaymentStatus } from '@prisma/client';

describe('PaymentsService - Performance Tests', () => {
  let service: PaymentsService;
  let prisma: PrismaService;
  let cieloService: CieloService;

  const mockPrismaService = {
    registration: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    payment: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const mockCieloService = {
    createPayment: jest.fn(),
    capturePayment: jest.fn(),
    getPayment: jest.fn(),
    mapCieloStatusToPaymentStatus: jest.fn(),
    mapCieloStatusToString: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: CieloService,
          useValue: mockCieloService,
        },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
    prisma = module.get<PrismaService>(PrismaService);
    cieloService = module.get<CieloService>(CieloService);

    mockPrismaService.$transaction.mockImplementation(async (callback) => {
      return callback(mockPrismaService);
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('High Concurrency - Payment Queries', () => {
    beforeEach(() => {
      mockPrismaService.payment.findUnique.mockResolvedValue({
        id: 'payment-123',
        userId: 'user-123',
        transactionId: 'cielo-payment-id',
        registration: {
          event: {
            id: 'event-id',
          },
          user: {
            id: 'user-123',
            firstName: 'John',
            lastName: 'Doe',
            email: 'john@example.com',
          },
        },
      });
      mockCieloService.getPayment.mockResolvedValue({
        Payment: {
          PaymentId: 'cielo-payment-id',
          Status: 2,
          Amount: 10000,
          Currency: 'BRL',
        },
      });
      mockCieloService.mapCieloStatusToString.mockReturnValue('Paid');
    });

    it('should handle 2000 concurrent payment queries efficiently', async () => {
      const concurrentRequests = 2000;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, (_, i) => {
        return service.findOne(`payment-${i}`, `user-${i}`).catch((error) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !r.error).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(10000); // Reads should be fast
      expect(throughput).toBeGreaterThan(100); // At least 100 reads per second

      console.log(`✅ Processed ${concurrentRequests} concurrent payment queries:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 15000);
  });
});
