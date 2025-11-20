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

  describe('High Concurrency - Payment Creation', () => {
    const userId = 'user-123';
    const createPaymentDto = {
      registrationId: 'registration-123',
      method: PaymentMethod.PIX,
      metadata: {},
    };

    const mockRegistration = {
      id: 'registration-123',
      userId: userId,
      finalAmount: 100.0,
      status: 'PENDING',
      event: {
        id: 'event-id',
        name: 'Test Event',
      },
      user: {
        id: userId,
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
      },
      payment: null,
    };

    const mockCieloResult = {
      success: true,
      paymentId: 'cielo-payment-id',
      clientSecret: 'client-secret',
      qrCode: 'qr-code',
      pixCode: 'pix-code',
      expiresAt: new Date(),
    };

    const mockPayment = {
      id: 'payment-id',
      registrationId: 'registration-123',
      userId: userId,
      method: PaymentMethod.PIX,
      status: PaymentStatus.PENDING,
      amount: 100.0,
      transactionId: 'cielo-payment-id',
      metadata: {},
    };

    beforeEach(() => {
      mockPrismaService.registration.findUnique.mockResolvedValue(mockRegistration);
      mockCieloService.createPayment.mockResolvedValue(mockCieloResult);
      mockPrismaService.payment.create.mockResolvedValue(mockPayment);
    });

    it('should handle 200 concurrent payment creations efficiently', async () => {
      const concurrentRequests = 200;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, (_, i) => {
        const dto = {
          ...createPaymentDto,
          registrationId: `registration-${i}`,
        };
        return service.create(`user-${i}`, dto).catch((error) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !r.error).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(10000); // Should complete within 10 seconds
      expect(throughput).toBeGreaterThan(15); // At least 15 requests per second

      console.log(`✅ Processed ${concurrentRequests} concurrent payment creations:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 15000);

    it('should handle 500 concurrent payment creations with acceptable performance', async () => {
      const concurrentRequests = 500;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, (_, i) => {
        const dto = {
          ...createPaymentDto,
          registrationId: `registration-${i}`,
        };
        return service.create(`user-${i}`, dto).catch((error) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !r.error).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(30000); // Should complete within 30 seconds
      expect(throughput).toBeGreaterThan(10); // At least 10 requests per second

      console.log(`✅ Processed ${concurrentRequests} concurrent payment creations:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 35000);
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

  describe('High Concurrency - Payment Processing', () => {
    const userId = 'user-123';
    const processPaymentDto = {
      paymentId: 'payment-123',
      transactionId: 'cielo-payment-id',
      metadata: {},
    };

    const mockPayment = {
      id: 'payment-123',
      userId: userId,
      registrationId: 'registration-123',
      status: PaymentStatus.PENDING,
      transactionId: 'cielo-payment-id',
      metadata: {},
      registration: {
        id: 'registration-123',
      },
    };

    const mockCieloPayment = {
      Payment: {
        PaymentId: 'cielo-payment-id',
        Status: 2,
        Amount: 10000,
        Currency: 'BRL',
      },
    };

    beforeEach(() => {
      mockPrismaService.payment.findUnique.mockResolvedValue(mockPayment);
      mockCieloService.getPayment.mockResolvedValue(mockCieloPayment);
      mockCieloService.mapCieloStatusToPaymentStatus.mockReturnValue(PaymentStatus.PAID);
      mockCieloService.mapCieloStatusToString.mockReturnValue('Paid');
      mockPrismaService.payment.update.mockResolvedValue({
        ...mockPayment,
        status: PaymentStatus.PAID,
      });
      mockPrismaService.registration.update.mockResolvedValue({});
    });

    it('should handle 300 concurrent payment processing efficiently', async () => {
      const concurrentRequests = 300;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, (_, i) => {
        const dto = {
          ...processPaymentDto,
          paymentId: `payment-${i}`,
        };
        return service.processPayment(`user-${i}`, dto).catch((error) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !r.error).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(15000); // Should complete within 15 seconds
      expect(throughput).toBeGreaterThan(15); // At least 15 requests per second

      console.log(`✅ Processed ${concurrentRequests} concurrent payment processing:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 20000);
  });
});
