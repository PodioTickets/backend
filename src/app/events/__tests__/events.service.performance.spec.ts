import { Test, TestingModule } from '@nestjs/testing';
import { EventsService } from '../events.service';
import { PrismaService } from '../../../prisma/prisma.service';

describe('EventsService - Performance Tests', () => {
  let service: EventsService;
  let prisma: PrismaService;

  const mockPrismaService = {
    organizer: {
      findUnique: jest.fn(),
    },
    event: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    eventTopic: {
      create: jest.fn(),
      createMany: jest.fn(),
    },
    eventLocation: {
      create: jest.fn(),
    },
    getReadClient: jest.fn(),
    getWriteClient: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);
    prisma = module.get<PrismaService>(PrismaService);

    mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
    mockPrismaService.getWriteClient.mockReturnValue(mockPrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('High Concurrency - Event Queries', () => {
    beforeEach(() => {
      mockPrismaService.event.findMany.mockResolvedValue([
        {
          id: 'event-1',
          name: 'Test Event',
          eventDate: new Date(),
          city: 'São Paulo',
          status: 'ACTIVE',
        },
      ]);
      mockPrismaService.event.count.mockResolvedValue(1);
    });

    it('should handle 5000 concurrent event queries efficiently', async () => {
      const concurrentRequests = 5000;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, () => {
        return service.findAll({ page: 1, limit: 10 }).catch((error) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !r.error).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(10000); // Reads should be very fast
      expect(throughput).toBeGreaterThan(200); // At least 200 reads per second

      console.log(`✅ Processed ${concurrentRequests} concurrent event queries:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 15000);

    it('should handle complex filtered queries under load', async () => {
      const concurrentRequests = 1000;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, (_, i) => {
        return service
          .findAll({
            page: 1,
            limit: 20,
            city: `City${i % 10}`,
            status: 'ACTIVE',
          })
          .catch((error) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !r.error).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(5000);
      expect(throughput).toBeGreaterThan(100);

      console.log(`✅ Processed ${concurrentRequests} filtered queries:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 10000);
  });

  describe('High Concurrency - Event Details', () => {
    beforeEach(() => {
      mockPrismaService.event.findUnique.mockResolvedValue({
        id: 'event-123',
        name: 'Test Event',
        description: 'Test Description',
        eventDate: new Date(),
        city: 'São Paulo',
        status: 'ACTIVE',
        organizer: {
          id: 'org-123',
          name: 'Test Organizer',
        },
        modalities: [],
        questions: [],
        kits: [],
      });
    });

    it('should handle 3000 concurrent event detail queries efficiently', async () => {
      const concurrentRequests = 3000;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, (_, i) => {
        return service.findOne(`event-${i}`).catch((error) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !r.error).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(8000);
      expect(throughput).toBeGreaterThan(150);

      console.log(`✅ Processed ${concurrentRequests} concurrent event detail queries:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 12000);
  });
});
