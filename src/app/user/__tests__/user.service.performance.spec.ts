import { Test, TestingModule } from '@nestjs/testing';
import { UserService } from '../user.service';
import { PrismaService } from '../../../prisma/prisma.service';

describe('UserService - Performance Tests', () => {
  let service: UserService;
  let prisma: PrismaService;

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    getReadClient: jest.fn(),
    getWriteClient: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
    prisma = module.get<PrismaService>(PrismaService);

    mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('High Concurrency - User Queries', () => {
    beforeEach(() => {
      mockPrismaService.user.findMany.mockResolvedValue([
        {
          id: 'user-1',
          email: 'user1@example.com',
          firstName: 'User',
          lastName: 'One',
          role: 'USER',
          isActive: true,
        },
      ]);
    });

    it('should handle 3000 concurrent user list queries efficiently', async () => {
      const concurrentRequests = 3000;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, () => {
        return service.findAll({ page: 1, limit: 50 }).catch((error) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !r.error).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(8000);
      expect(throughput).toBeGreaterThan(150);

      console.log(`✅ Processed ${concurrentRequests} concurrent user queries:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 12000);

    it('should handle paginated queries efficiently', async () => {
      const pages = 100;
      const startTime = Date.now();

      const promises = Array.from({ length: pages }, (_, i) => {
        return service
          .findAll({ page: i + 1, limit: 20 })
          .catch((error) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !r.error).length;
      const avgTimePerPage = duration / pages;

      expect(successful).toBeGreaterThan(0);
      expect(avgTimePerPage).toBeLessThan(100); // Each page should be fast

      console.log(`✅ Processed ${pages} paginated queries:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Total duration: ${duration}ms`);
      console.log(`   - Average per page: ${avgTimePerPage.toFixed(2)}ms`);
    }, 15000);
  });

  describe('High Concurrency - User Details', () => {
    beforeEach(() => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'user@example.com',
        firstName: 'John',
        lastName: 'Doe',
        role: 'USER',
        isActive: true,
      });
    });

    it('should handle 5000 concurrent user detail queries efficiently', async () => {
      const concurrentRequests = 5000;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, (_, i) => {
        return service.findOne(`user-${i}`).catch((error) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !r.error).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(10000);
      expect(throughput).toBeGreaterThan(200);

      console.log(`✅ Processed ${concurrentRequests} concurrent user detail queries:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 15000);
  });
});
