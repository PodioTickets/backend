import { Test, TestingModule } from '@nestjs/testing';
import { EventsService } from '../events.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrganizerMemberAccessService } from '../../organizations/organizer-member-access.service';
import { OrganizationsService } from '../../organizations/organizations.service';
import { TicketsService } from '../../tickets/tickets.service';
import { TicketCategoriesService } from '../../ticket-categories/ticket-categories.service';
import { EmailService } from '../../../common/services/email.service';
import { RepasseService } from '../../repasse/repasse.service';
import { CacheRedisService } from '../../../common/services/cache-redis.service';
import { EventStatus } from '@prisma/client';

/** Gera um UUID v4-like determinístico por índice (findOne/findBySlug validam o formato). */
function uuidForIndex(i: number): string {
  const hex = i.toString(16).padStart(12, '0');
  return `e1111111-1111-1111-1111-${hex}`;
}

describe('EventsService - Performance Tests', () => {
  let service: EventsService;
  let prisma: PrismaService;

  const mockPrismaService = {
    organizer: {
      findUnique: jest.fn(),
    },
    organizationMember: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
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
    ticket: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    registrationTicket: {
      groupBy: jest.fn().mockResolvedValue([]),
    },
    registration: {
      count: jest.fn().mockResolvedValue(0),
    },
    user: {
      findUnique: jest.fn(),
    },
    getReadClient: jest.fn(),
    getWriteClient: jest.fn(),
  };

  const mockOrganizerMemberAccess = {
    getMemberForOrganizerUser: jest.fn(),
    buildOrganizerEventsWhere: jest.fn(),
    assertCanAccessEvent: jest.fn().mockResolvedValue(undefined),
  };

  const mockOrganizationsService = {
    recordOrganizationAuditLog: jest.fn().mockResolvedValue(undefined),
  };

  const mockTicketsService = {};
  const mockTicketCategoriesService = {};
  const mockEmailService = {};
  const mockRepasseService = {};
  const mockCacheRedisService = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: OrganizerMemberAccessService,
          useValue: mockOrganizerMemberAccess,
        },
        {
          provide: OrganizationsService,
          useValue: mockOrganizationsService,
        },
        {
          provide: TicketsService,
          useValue: mockTicketsService,
        },
        {
          provide: TicketCategoriesService,
          useValue: mockTicketCategoriesService,
        },
        {
          provide: EmailService,
          useValue: mockEmailService,
        },
        {
          provide: RepasseService,
          useValue: mockRepasseService,
        },
        {
          provide: CacheRedisService,
          useValue: mockCacheRedisService,
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
          status: EventStatus.PUBLISHED,
        },
      ]);
      mockPrismaService.event.count.mockResolvedValue(1);
    });

    it('should handle 5000 concurrent event queries efficiently', async () => {
      const concurrentRequests = 5000;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, () => {
        return service
          .findAll({ page: 1, limit: 10 })
          .catch((error: unknown) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter(
        (r) => !('error' in r),
      ).length;
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
            status: EventStatus.PUBLISHED,
          })
          .catch((error: unknown) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter(
        (r) => !('error' in r),
      ).length;
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
        status: EventStatus.PUBLISHED,
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
        // findOne valida o formato UUID do id; usamos ids válidos por índice.
        return service.findOne(uuidForIndex(i)).catch((error: unknown) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter(
        (r) => !('error' in r),
      ).length;
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
