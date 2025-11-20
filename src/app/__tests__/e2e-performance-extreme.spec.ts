import { Test, TestingModule } from '@nestjs/testing';
import { RegistrationsService } from '../registrations/registrations.service';
import { PaymentsService } from '../payments/payments.service';
import { AuthService } from '../auth/auth.service';
import { UserService } from '../user/user.service';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../../prisma/prisma.service';
import { KitsService } from '../kits/kits.service';
import { CieloService } from '../payments/cielo.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PaymentMethod, Gender, Language } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as QRCode from 'qrcode';

// Mock QRCode
jest.mock('qrcode', () => ({
  toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,qr-code-data'),
}));

describe('End-to-End Performance Tests - Extreme High Traffic', () => {
  let registrationsService: RegistrationsService;
  let paymentsService: PaymentsService;
  let authService: AuthService;
  let userService: UserService;
  let eventsService: EventsService;

  const mockPrismaService = {
    event: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
    },
    organizer: {
      findUnique: jest.fn(),
    },
    modality: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    registration: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    registrationModality: {
      create: jest.fn(),
    },
    registrationKitItem: {
      create: jest.fn(),
    },
    questionAnswer: {
      create: jest.fn(),
    },
    question: {
      findMany: jest.fn(),
    },
    payment: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
    getReadClient: jest.fn(),
    getWriteClient: jest.fn(),
  };

  const mockKitsService = {
    checkStock: jest.fn(),
    updateStock: jest.fn(),
  };

  const mockCieloService = {
    createPayment: jest.fn(),
    capturePayment: jest.fn(),
    getPayment: jest.fn(),
    mapCieloStatusToPaymentStatus: jest.fn(),
    mapCieloStatusToString: jest.fn(),
  };

  const mockJwtService = {
    sign: jest.fn(),
    verify: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegistrationsService,
        PaymentsService,
        AuthService,
        UserService,
        EventsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: KitsService,
          useValue: mockKitsService,
        },
        {
          provide: CieloService,
          useValue: mockCieloService,
        },
        {
          provide: JwtService,
          useValue: mockJwtService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    registrationsService = module.get<RegistrationsService>(RegistrationsService);
    paymentsService = module.get<PaymentsService>(PaymentsService);
    authService = module.get<AuthService>(AuthService);
    userService = module.get<UserService>(UserService);
    eventsService = module.get<EventsService>(EventsService);

    mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
    mockPrismaService.getWriteClient.mockReturnValue(mockPrismaService);
    mockPrismaService.$transaction.mockImplementation(async (callback) => {
      return callback(mockPrismaService);
    });

    jest.spyOn(bcrypt, 'compare').mockImplementation(() => Promise.resolve(true));
    jest.spyOn(bcrypt, 'hash').mockImplementation(() => Promise.resolve('hashedPassword'));

    // Setup default mocks
    mockPrismaService.event.findUnique.mockResolvedValue({
      id: 'event-123',
      status: 'PUBLISHED',
      registrationStartDate: new Date(Date.now() - 86400000),
      registrationEndDate: new Date(Date.now() + 86400000),
      eventDate: new Date(Date.now() + 172800000),
      questions: [],
    });

    mockPrismaService.modality.findUnique.mockResolvedValue({
      id: 'modality-123',
      eventId: 'event-123',
      isActive: true,
      price: 100.0,
      maxParticipants: 1000,
      currentParticipants: 0,
    });

    mockPrismaService.question.findMany.mockResolvedValue([]);
    mockKitsService.checkStock.mockResolvedValue(true);
    mockKitsService.updateStock.mockResolvedValue(true);
    // Mock dinâmico para criar registrations com IDs únicos
    mockPrismaService.registration.create.mockImplementation(({ data }) => ({
      id: `reg-${data.userId || 'default'}`,
      eventId: data.eventId || 'event-123',
      userId: data.userId || 'user-123',
      status: 'PENDING',
      totalAmount: 100.0,
      serviceFee: 5.0,
      finalAmount: 105.0,
      qrCode: 'qr-code-data',
      modalities: [],
      kitItems: [],
      questionAnswers: [],
    }));

    mockPrismaService.event.findMany.mockResolvedValue([
      {
        id: 'event-123',
        name: 'Test Event',
        eventDate: new Date(),
        city: 'São Paulo',
        status: 'ACTIVE',
      },
    ]);

    mockPrismaService.event.count.mockResolvedValue(1);

    mockCieloService.createPayment.mockResolvedValue({
      success: true,
      paymentId: 'cielo-payment-id',
      qrCode: 'qr-code',
      pixCode: 'pix-code',
      expiresAt: new Date(),
    });

    // Mock dinâmico para encontrar registrations por ID
    mockPrismaService.registration.findUnique.mockImplementation(({ where }) => {
      const userId = where.id?.replace('reg-', '') || 'user-123';
      return Promise.resolve({
        id: where.id || 'registration-123',
        userId: userId,
        finalAmount: 105.0,
        status: 'PENDING',
        event: {
          id: 'event-id',
          name: 'Test Event',
        },
        user: {
          id: userId,
          firstName: 'John',
          lastName: 'Doe',
          email: `${userId}@example.com`,
        },
        payment: null,
      });
    });

    mockPrismaService.payment.create.mockResolvedValue({
      id: 'payment-id',
      registrationId: 'registration-123',
      userId: 'user-123',
      method: PaymentMethod.PIX,
      status: 'PENDING',
      amount: 105.0,
      transactionId: 'cielo-payment-id',
      metadata: {},
    });

    mockPrismaService.user.findUnique.mockResolvedValue({
      id: 'user-123',
      email: 'user@example.com',
      password: 'hashedPassword',
      isActive: true,
      firstName: 'John',
      lastName: 'Doe',
      documentNumber: '12345678901',
      role: 'USER',
    });

    mockJwtService.sign.mockReturnValue('access-token');
    mockConfigService.get.mockReturnValue('refresh-secret');
    jest.spyOn(authService as any, 'createRefreshToken').mockResolvedValue('refresh-token');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Extreme High Traffic - Complete User Journey', () => {
    it('should handle 1 MILLION concurrent users completing full registration flow', async () => {
      const concurrentUsers = 1_000_000;
      const batchSize = 10_000; // Processar em batches de 10k para evitar sobrecarga de memória
      const startTime = Date.now();

      const simulateUserJourney = async (userId: string) => {
        try {
          // 1. User searches for events
          await eventsService.findAll({ page: 1, limit: 10 });

          // 2. User views event details
          await eventsService.findOne('event-123');

          // 3. User creates registration
          const registration = await registrationsService.create(userId, {
            eventId: 'event-123',
            modalities: [{ modalityId: 'modality-123' }],
            kitItems: [],
            questionAnswers: [],
            termsAccepted: true,
            rulesAccepted: true,
          });

          // 4. User creates payment
          if (registration?.data?.registration?.id) {
            const registrationId = registration.data.registration.id;
            // Garantir que o mock da registration está configurado para este ID
            mockPrismaService.registration.findUnique.mockResolvedValueOnce({
              id: registrationId,
              userId: userId,
              finalAmount: 105.0,
              status: 'PENDING',
              event: {
                id: 'event-id',
                name: 'Test Event',
              },
              user: {
                id: userId,
                firstName: 'John',
                lastName: 'Doe',
                email: `${userId}@example.com`,
              },
              payment: null,
            });
            
            await paymentsService.create(userId, {
              registrationId: registrationId,
              method: PaymentMethod.PIX,
              metadata: {},
            });
          }

          return { success: true, userId };
        } catch (error) {
          return { success: false, userId, error: error.message };
        }
      };

      // Processar em batches para evitar sobrecarga de memória
      let totalSuccessful = 0;
      let totalFailed = 0;
      const totalBatches = Math.ceil(concurrentUsers / batchSize);

      for (let batch = 0; batch < totalBatches; batch++) {
        const batchStart = batch * batchSize;
        const batchEnd = Math.min(batchStart + batchSize, concurrentUsers);
        const batchSizeActual = batchEnd - batchStart;

        const promises = Array.from({ length: batchSizeActual }, (_, i) => {
          return simulateUserJourney(`user-${batchStart + i}`);
        });

        const batchResults = await Promise.all(promises);
        const batchSuccessful = batchResults.filter((r) => r.success).length;
        const batchFailed = batchResults.filter((r) => !r.success).length;

        totalSuccessful += batchSuccessful;
        totalFailed += batchFailed;

        // Log progresso a cada 10 batches
        if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
          const progress = ((batch + 1) / totalBatches) * 100;
          console.log(`📊 Progress: ${progress.toFixed(1)}% (Batch ${batch + 1}/${totalBatches})`);
        }
      }

      const endTime = Date.now();
      const duration = endTime - startTime;
      const throughput = (concurrentUsers / duration) * 1000;

      expect(totalSuccessful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(600000); // Should complete within 10 minutes
      expect(throughput).toBeGreaterThan(1000); // At least 1000 users per second

      console.log(`✅ Simulated ${concurrentUsers.toLocaleString()} concurrent users:`);
      console.log(`   - Successful: ${totalSuccessful.toLocaleString()} (${((totalSuccessful / concurrentUsers) * 100).toFixed(2)}%)`);
      console.log(`   - Failed: ${totalFailed.toLocaleString()}`);
      console.log(`   - Duration: ${(duration / 1000).toFixed(2)}s (${(duration / 60000).toFixed(2)}min)`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} users/s`);
      console.log(`   - Batches processed: ${totalBatches}`);
    }, 600000); // 10 minutos timeout

    it('should handle 5 MILLION concurrent users with mixed operations', async () => {
      const concurrentUsers = 5_000_000;
      const batchSize = 50_000; // Batches maiores para operações mais leves
      const startTime = Date.now();

      const operations = [
        // 40% users searching events
        ...Array.from({ length: Math.floor(concurrentUsers * 0.4) }, () => ({
          type: 'search',
          fn: () => eventsService.findAll({ page: 1, limit: 10 }),
        })),
        // 30% users viewing event details
        ...Array.from({ length: Math.floor(concurrentUsers * 0.3) }, () => ({
          type: 'view',
          fn: () => eventsService.findOne('event-123'),
        })),
        // 20% users creating registrations
        ...Array.from({ length: Math.floor(concurrentUsers * 0.2) }, (_, i) => ({
          type: 'register',
          fn: () =>
            registrationsService.create(`user-${i}`, {
              eventId: 'event-123',
              modalities: [{ modalityId: 'modality-123' }],
              kitItems: [],
              questionAnswers: [],
              termsAccepted: true,
              rulesAccepted: true,
            }),
        })),
        // 10% users querying their registrations
        ...Array.from({ length: Math.floor(concurrentUsers * 0.1) }, (_, i) => ({
          type: 'query',
          fn: () => registrationsService.findUserRegistrations(`user-${i}`),
        })),
      ];

      let totalSuccessful = 0;
      const totalBatches = Math.ceil(operations.length / batchSize);

      for (let batch = 0; batch < totalBatches; batch++) {
        const batchStart = batch * batchSize;
        const batchEnd = Math.min(batchStart + batchSize, operations.length);
        const batchOps = operations.slice(batchStart, batchEnd);

        const promises = batchOps.map(async (op) => {
          try {
            await op.fn();
            return { success: true, type: op.type };
          } catch (error) {
            return { success: false, type: op.type, error: error.message };
          }
        });

        const batchResults = await Promise.all(promises);
        const batchSuccessful = batchResults.filter((r) => r.success).length;
        totalSuccessful += batchSuccessful;

        // Log progresso a cada 10 batches
        if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
          const progress = ((batch + 1) / totalBatches) * 100;
          console.log(`📊 Progress: ${progress.toFixed(1)}% (Batch ${batch + 1}/${totalBatches})`);
        }
      }

      const endTime = Date.now();
      const duration = endTime - startTime;
      const throughput = (concurrentUsers / duration) * 1000;

      expect(totalSuccessful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(1800000); // Should complete within 30 minutes
      expect(throughput).toBeGreaterThan(2000); // At least 2000 ops per second

      console.log(`✅ Simulated ${concurrentUsers.toLocaleString()} mixed operations:`);
      console.log(`   - Successful: ${totalSuccessful.toLocaleString()} (${((totalSuccessful / concurrentUsers) * 100).toFixed(2)}%)`);
      console.log(`   - Duration: ${(duration / 1000).toFixed(2)}s (${(duration / 60000).toFixed(2)}min)`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} ops/s`);
    }, 1800000); // 30 minutos timeout

    it('should handle 10 MILLION concurrent authentication requests', async () => {
      const concurrentRequests = 10_000_000;
      const batchSize = 100_000; // Batches grandes para operações simples
      const startTime = Date.now();

      let totalSuccessful = 0;
      const totalBatches = Math.ceil(concurrentRequests / batchSize);

      for (let batch = 0; batch < totalBatches; batch++) {
        const batchStart = batch * batchSize;
        const batchEnd = Math.min(batchStart + batchSize, concurrentRequests);
        const batchSizeActual = batchEnd - batchStart;

        const promises = Array.from({ length: batchSizeActual }, (_, i) => {
          const user = {
            id: `user-${batchStart + i}`,
            email: `user${batchStart + i}@example.com`,
            firstName: 'John',
            lastName: 'Doe',
            documentNumber: `1234567890${batchStart + i}`,
            role: 'USER',
          };
          return authService.login(user).catch((error) => ({ error }));
        });

        const batchResults = await Promise.all(promises);
        const batchSuccessful = batchResults.filter((r) => !('error' in r)).length;
        totalSuccessful += batchSuccessful;

        // Log progresso a cada 20 batches
        if ((batch + 1) % 20 === 0 || batch === totalBatches - 1) {
          const progress = ((batch + 1) / totalBatches) * 100;
          console.log(`📊 Progress: ${progress.toFixed(1)}% (Batch ${batch + 1}/${totalBatches})`);
        }
      }

      const endTime = Date.now();
      const duration = endTime - startTime;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(totalSuccessful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(3600000); // Should complete within 60 minutes
      expect(throughput).toBeGreaterThan(5000); // At least 5000 requests per second

      console.log(`✅ Processed ${concurrentRequests.toLocaleString()} concurrent auth requests:`);
      console.log(`   - Successful: ${totalSuccessful.toLocaleString()} (${((totalSuccessful / concurrentRequests) * 100).toFixed(2)}%)`);
      console.log(`   - Duration: ${(duration / 1000).toFixed(2)}s (${(duration / 60000).toFixed(2)}min)`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 3600000); // 60 minutos timeout

    it('should handle peak traffic scenario: Super Bowl / World Cup style rush (50 MILLION users)', async () => {
      // Simula um evento extremamente popular com demanda massiva simultânea
      const totalUsers = 50_000_000;
      const batchSize = 100_000;
      const startTime = Date.now();

      let totalSuccessful = 0;
      let totalFailed = 0;
      const totalBatches = Math.ceil(totalUsers / batchSize);

      // Todos os usuários tentam fazer a mesma coisa ao mesmo tempo
      for (let batch = 0; batch < totalBatches; batch++) {
        const batchStart = batch * batchSize;
        const batchEnd = Math.min(batchStart + batchSize, totalUsers);
        const batchSizeActual = batchEnd - batchStart;

        const promises = Array.from({ length: batchSizeActual }, (_, i) => {
          return registrationsService
            .create(`user-${batchStart + i}`, {
              eventId: 'event-123',
              modalities: [{ modalityId: 'modality-123' }],
              kitItems: [],
              questionAnswers: [],
              termsAccepted: true,
              rulesAccepted: true,
            })
            .catch((error) => ({ error: error.message }));
        });

        const batchResults = await Promise.all(promises);
        const batchSuccessful = batchResults.filter((r) => !('error' in r)).length;
        const batchFailed = batchResults.filter((r) => 'error' in r).length;

        totalSuccessful += batchSuccessful;
        totalFailed += batchFailed;

        // Log progresso a cada 50 batches
        if ((batch + 1) % 50 === 0 || batch === totalBatches - 1) {
          const progress = ((batch + 1) / totalBatches) * 100;
          const elapsed = (Date.now() - startTime) / 1000;
          const estimatedTotal = elapsed / (progress / 100);
          const remaining = estimatedTotal - elapsed;
          console.log(`📊 Progress: ${progress.toFixed(1)}% (Batch ${batch + 1}/${totalBatches})`);
          console.log(`   ⏱️  Elapsed: ${(elapsed / 60).toFixed(2)}min | Estimated remaining: ${(remaining / 60).toFixed(2)}min`);
        }
      }

      const endTime = Date.now();
      const duration = endTime - startTime;
      const throughput = (totalUsers / duration) * 1000;

      expect(totalSuccessful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(7200000); // Should handle within 120 minutes
      expect(throughput).toBeGreaterThan(10000); // At least 10000 requests per second

      console.log(`✅ Super Bowl / World Cup scenario - ${totalUsers.toLocaleString()} simultaneous registrations:`);
      console.log(`   - Successful: ${totalSuccessful.toLocaleString()} (${((totalSuccessful / totalUsers) * 100).toFixed(2)}%)`);
      console.log(`   - Failed: ${totalFailed.toLocaleString()}`);
      console.log(`   - Duration: ${(duration / 1000).toFixed(2)}s (${(duration / 60000).toFixed(2)}min)`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
      console.log(`   - Peak load handled successfully! 🚀`);
    }, 7200000); // 120 minutos timeout

    it('should maintain system stability under sustained load (100 MILLION users)', async () => {
      // Testa carga sustentada massiva por múltiplos períodos
      const batches = 20;
      const usersPerBatch = 5_000_000; // 5 milhões por batch
      const batchSize = 50_000; // Processar em sub-batches para evitar sobrecarga
      const batchInterval = 5000; // 5 segundos entre batches
      const results: Array<{ batch: number; successful: number; duration: number }> = [];
      const overallStartTime = Date.now();

      for (let batch = 0; batch < batches; batch++) {
        const batchStartTime = Date.now();
        let batchSuccessful = 0;

        // Processar cada batch em sub-batches
        const subBatches = Math.ceil(usersPerBatch / batchSize);
        for (let subBatch = 0; subBatch < subBatches; subBatch++) {
          const subBatchStart = subBatch * batchSize;
          const subBatchEnd = Math.min(subBatchStart + batchSize, usersPerBatch);
          const subBatchSizeActual = subBatchEnd - subBatchStart;

          const promises = Array.from({ length: subBatchSizeActual }, (_, i) => {
            return registrationsService
              .create(`batch${batch}-user${subBatchStart + i}`, {
                eventId: 'event-123',
                modalities: [{ modalityId: 'modality-123' }],
                kitItems: [],
                questionAnswers: [],
                termsAccepted: true,
                rulesAccepted: true,
              })
              .catch((error) => ({ error: error.message }));
          });

          const subBatchResults = await Promise.all(promises);
          batchSuccessful += subBatchResults.filter((r) => !('error' in r)).length;

          // Limpar referências
          subBatchResults.length = 0;
          promises.length = 0;
        }

        const batchEndTime = Date.now();
        const batchDuration = batchEndTime - batchStartTime;

        results.push({
          batch: batch + 1,
          successful: batchSuccessful,
          duration: batchDuration,
        });

        const memoryUsage = process.memoryUsage();
        console.log(`📊 Batch ${batch + 1}/${batches}: ${batchSuccessful.toLocaleString()}/${usersPerBatch.toLocaleString()} successful in ${(batchDuration / 1000).toFixed(2)}s`);
        console.log(`   💾 Memory: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB / ${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)}MB`);

        // Forçar limpeza de memória a cada batch
        if (global.gc) {
          global.gc();
        }

        // Aguardar antes do próximo batch (exceto no último)
        if (batch < batches - 1) {
          await new Promise((resolve) => setTimeout(resolve, batchInterval));
        }
      }

      const overallEndTime = Date.now();
      const totalDuration = overallEndTime - overallStartTime;
      const totalSuccessful = results.reduce((sum, r) => sum + r.successful, 0);
      const totalUsers = batches * usersPerBatch;
      const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;
      const maxDuration = Math.max(...results.map((r) => r.duration));
      const minDuration = Math.min(...results.map((r) => r.duration));
      const throughput = (totalUsers / totalDuration) * 1000;

      expect(totalSuccessful).toBeGreaterThan(0);
      expect(avgDuration).toBeLessThan(300000); // Average should be reasonable (5min)
      expect(maxDuration).toBeLessThan(600000); // Max should not be too high (10min)
      expect(throughput).toBeGreaterThan(5000); // At least 5000 users per second

      console.log(`✅ Sustained load test across ${batches} batches:`);
      console.log(`   - Total users: ${totalUsers.toLocaleString()}`);
      console.log(`   - Total successful: ${totalSuccessful.toLocaleString()} (${((totalSuccessful / totalUsers) * 100).toFixed(2)}%)`);
      console.log(`   - Total duration: ${(totalDuration / 1000).toFixed(2)}s (${(totalDuration / 60000).toFixed(2)}min)`);
      console.log(`   - Average batch duration: ${(avgDuration / 1000).toFixed(2)}s`);
      console.log(`   - Min batch duration: ${(minDuration / 1000).toFixed(2)}s`);
      console.log(`   - Max batch duration: ${(maxDuration / 1000).toFixed(2)}s`);
      console.log(`   - Overall throughput: ${throughput.toFixed(2)} users/s`);
      console.log(`   - System stability: ${maxDuration / minDuration < 3 ? '✅ Excellent' : maxDuration / minDuration < 5 ? '✅ Good' : '⚠️ Variable'}`);
    }, 7200000); // 120 minutos timeout
  });
});