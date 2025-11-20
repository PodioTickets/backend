import { Test, TestingModule } from '@nestjs/testing';
import { RegistrationsService } from '../registrations.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { KitsService } from '../../kits/kits.service';

describe('RegistrationsService - Performance Tests', () => {
  let service: RegistrationsService;
  let prisma: PrismaService;
  let kitsService: KitsService;

  const mockPrismaService = {
    event: {
      findUnique: jest.fn(),
    },
    modality: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
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
    $transaction: jest.fn(),
    getReadClient: jest.fn(),
    getWriteClient: jest.fn(),
  };

  const mockKitsService = {
    checkStock: jest.fn(),
    updateStock: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegistrationsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: KitsService,
          useValue: mockKitsService,
        },
      ],
    }).compile();

    service = module.get<RegistrationsService>(RegistrationsService);
    prisma = module.get<PrismaService>(PrismaService);
    kitsService = module.get<KitsService>(KitsService);

    mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
    mockPrismaService.getWriteClient.mockReturnValue(mockPrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('High Concurrency - Batch Registration Creation', () => {
    const createRegistrationDto = {
      eventId: 'event-123',
      modalities: [{ modalityId: 'modality-123' }],
      kitItems: [],
      questionAnswers: [],
      termsAccepted: true,
      rulesAccepted: true,
    };

    const mockEvent = {
      id: 'event-123',
      status: 'PUBLISHED',
      registrationStartDate: new Date(Date.now() - 86400000),
      registrationEndDate: new Date(Date.now() + 86400000),
      eventDate: new Date(Date.now() + 172800000),
      maxRegistrations: 1000,
      currentRegistrations: 0,
      questions: [],
    };

    const mockModality = {
      id: 'modality-123',
      eventId: 'event-123',
      availableSlots: 100,
      currentParticipants: 0,
      maxParticipants: 1000,
      price: 100.0,
      isActive: true,
    };

    beforeEach(() => {
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);
      mockPrismaService.question.findMany.mockResolvedValue([]);
      mockKitsService.checkStock.mockResolvedValue(true);
      mockKitsService.updateStock.mockResolvedValue(true);
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        return callback(mockPrismaService);
      });
      mockPrismaService.registration.create.mockResolvedValue({
        id: 'reg-123',
        eventId: 'event-123',
        userId: 'user-123',
        status: 'PENDING',
        totalAmount: 100.0,
        serviceFee: 5.0,
        finalAmount: 105.0,
        qrCode: 'qr-code-data',
      });
      mockPrismaService.modality.update.mockResolvedValue(mockModality);
    });

    it('should handle 100 concurrent registrations efficiently', async () => {
      const concurrentRequests = 100;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, (_, i) => {
        const dto = {
          ...createRegistrationDto,
          email: `user${i}@example.com`,
          documentNumber: `1234567890${i}`,
        };
        return service.create(`user-${i}`, dto).catch((error) => ({ error: error.message }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !('error' in r)).length;
      const failed = results.filter((r) => 'error' in r).length;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
      expect(mockPrismaService.$transaction).toHaveBeenCalledTimes(successful);
      
      console.log(`✅ Processed ${concurrentRequests} concurrent registrations:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Failed: ${failed}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${(concurrentRequests / duration * 1000).toFixed(2)} req/s`);
    }, 10000);

    it('should handle 500 concurrent registrations within acceptable time', async () => {
      const concurrentRequests = 500;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, (_, i) => {
        return service.create(`user-${i}`, createRegistrationDto).catch((error) => ({ error: error.message }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !('error' in r)).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(30000); // Should complete within 30 seconds
      expect(throughput).toBeGreaterThan(10); // At least 10 requests per second

      console.log(`✅ Processed ${concurrentRequests} concurrent registrations:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 35000);

    it('should handle 1000 concurrent registrations with acceptable performance', async () => {
      const concurrentRequests = 1000;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, (_, i) => {
        return service.create(`user-${i}`, createRegistrationDto).catch((error) => ({ error: error.message }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !('error' in r)).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(60000); // Should complete within 60 seconds
      expect(throughput).toBeGreaterThan(15); // At least 15 requests per second

      console.log(`✅ Processed ${concurrentRequests} concurrent registrations:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 65000);

    it('should maintain consistent performance under load', async () => {
      const batches = 10;
      const requestsPerBatch = 50;
      const durations: number[] = [];

      for (let batch = 0; batch < batches; batch++) {
        const startTime = Date.now();
        
        const promises = Array.from({ length: requestsPerBatch }, (_, i) => {
          return service.create(`batch${batch}-user${i}`, createRegistrationDto).catch((error) => ({ error: error.message }));
        });

        await Promise.all(promises);
        const endTime = Date.now();
        durations.push(endTime - startTime);
      }

      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      const maxDuration = Math.max(...durations);
      const minDuration = Math.min(...durations);

      expect(avgDuration).toBeLessThan(3000); // Average should be under 3 seconds
      expect(maxDuration).toBeLessThan(5000); // Max should be under 5 seconds

      console.log(`✅ Performance consistency across ${batches} batches:`);
      console.log(`   - Average duration: ${avgDuration.toFixed(2)}ms`);
      console.log(`   - Min duration: ${minDuration}ms`);
      console.log(`   - Max duration: ${maxDuration}ms`);
    }, 60000);
  });

  describe('High Concurrency - Registration Queries', () => {
    beforeEach(() => {
      mockPrismaService.registration.findMany.mockResolvedValue([
        {
          id: 'reg-1',
          eventId: 'event-123',
          userId: 'user-123',
          status: 'PENDING',
          event: {
            organizer: {
              id: 'org-1',
              name: 'Organizer',
              email: 'org@example.com',
              phone: '1234567890',
            },
          },
          user: {
            id: 'user-123',
            firstName: 'John',
            lastName: 'Doe',
            documentNumber: '12345678901',
            dateOfBirth: new Date('2000-01-01'),
          },
          modalities: [],
          kitItems: [],
          payment: null,
        },
      ]);
    });

    it('should handle 1000 concurrent read operations efficiently', async () => {
      const concurrentRequests = 1000;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, (_, i) => {
        return service.findUserRegistrations(`user-${i}`).catch((error) => ({ error: error.message }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !('error' in r)).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(5000); // Reads should be fast
      expect(throughput).toBeGreaterThan(100); // At least 100 reads per second

      console.log(`✅ Processed ${concurrentRequests} concurrent read operations:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 10000);
  });
});
