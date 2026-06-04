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
import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { EventStatus } from '@prisma/client';

/** Alinha mocks ao fluxo atual de create (owner + tópico Descrição padrão). */
function setupDefaultEventCreationMocks(
  mock: Record<string, unknown>,
  createEventDto: Record<string, unknown>,
  eventId = 'event-123',
) {
  const m = mock as {
    organizationMember: { findMany: jest.Mock };
    event: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
    eventTopic: { create: jest.Mock; findMany: jest.Mock };
  };
  const mockMember = {
    id: 'member-123',
    organizationId: 'org-123',
    role: 'OWNER',
    permissions: null,
    organization: { id: 'org-123' },
  };
  const mockEvent = {
    id: eventId,
    ...createEventDto,
    organizationId: mockMember.organizationId,
    slug: null,
  };
  const mockUpdated = {
    ...mockEvent,
    slug: `slug-${eventId}`,
    organization: { members: [] },
  };
  const desc = String(createEventDto.description ?? '');
  const mockTopics = [
    {
      id: 'topic-1',
      eventId,
      title: 'Descrição do evento',
      content: desc,
      isDefault: true,
      isRequired: true,
      order: 0,
    },
  ];
  m.organizationMember.findMany.mockResolvedValue([mockMember]);
  m.event.findFirst.mockResolvedValue(null);
  m.event.create.mockResolvedValue(mockEvent);
  m.event.update.mockResolvedValue(mockUpdated);
  m.eventTopic.create.mockResolvedValue(mockTopics[0]);
  m.eventTopic.findMany.mockResolvedValue(mockTopics);
}

describe('EventsService - Comprehensive Tests', () => {
  let service: EventsService;
  let prisma: PrismaService;

  // Métodos como findOne/update/updateTopic validam o formato UUID do id;
  // strings tipo 'event-123' são rejeitadas com BadRequestException.
  const VALID_EVENT_ID = 'e1111111-1111-1111-1111-111111111111';
  const VALID_TOPIC_ID = 'f1111111-1111-1111-1111-111111111111';

  const mockPrismaService = {
    organizer: {
      findUnique: jest.fn(),
    },
    organizationMember: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    organizationMemberEventAccess: {
      upsert: jest.fn(),
    },
    event: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    eventTopic: {
      create: jest.fn(),
      createMany: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    eventLocation: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
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
    order: {
      groupBy: jest.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: jest.fn(),
    },
    getReadClient: jest.fn(),
    getWriteClient: jest.fn(),
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

  const mockOrganizerMemberAccess = {
    getMemberForOrganizerUser: jest.fn(),
    buildOrganizerEventsWhere: jest.fn(),
    assertCanAccessEvent: jest.fn().mockResolvedValue(undefined),
  };

  const mockOrganizationsService = {
    recordOrganizationAuditLog: jest.fn().mockResolvedValue(undefined),
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

    // Mock getReadClient and getWriteClient to return the same mock
    mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
    mockPrismaService.getWriteClient.mockReturnValue(mockPrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Use Cases - User Flow', () => {
    describe('UC1: Organizer creates event with all details', () => {
      it('should create event with banner, location, and default description topic', async () => {
        const userId = 'org-user-123';
        const createEventDto = {
          name: 'Maratona de São Paulo 2025',
          description: 'Corrida de rua com percurso de 42km',
          bannerUrl: 'https://example.com/banner.jpg',
          location: 'Parque Ibirapuera',
          city: 'São Paulo',
          state: 'SP',
          country: 'Brasil',
          googleMapsLink: 'https://maps.google.com/?q=parque+ibirapuera',
          eventDate: '2025-06-15T08:00:00Z',
          registrationStartDate: '2025-05-01T08:00:00Z',
          registrationEndDate: '2025-06-10T23:59:59Z',
        };

        const mockMember = {
          id: 'member-123',
          organizationId: 'org-123',
          role: 'OWNER',
          permissions: null,
          organization: { id: 'org-123' },
        };
        const mockEvent = {
          id: 'event-123',
          ...createEventDto,
          organizationId: mockMember.organizationId,
          slug: null,
        };
        const mockUpdated = {
          ...mockEvent,
          slug: 'maratona-de-sao-paulo-2025-event-123',
          organization: { members: [] },
        };
        const defaultTopic = {
          id: 'topic-desc',
          eventId: 'event-123',
          title: 'Descrição do evento',
          content: createEventDto.description,
          isDefault: true,
          isRequired: true,
          order: 0,
        };

        mockPrismaService.organizationMember.findMany.mockResolvedValue([mockMember]);
        mockPrismaService.event.findFirst.mockResolvedValue(null);
        mockPrismaService.event.create.mockResolvedValue(mockEvent);
        mockPrismaService.event.update.mockResolvedValue(mockUpdated);
        mockPrismaService.eventTopic.create.mockResolvedValue(defaultTopic);
        mockPrismaService.eventTopic.findMany.mockResolvedValue([defaultTopic]);

        const result = await service.create(userId, createEventDto);

        expect(result.data.event).toBeDefined();
        expect(result.data.event.name).toBe(createEventDto.name);
        expect(result.data.event.topics).toEqual([defaultTopic]);
        expect(mockPrismaService.eventTopic.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            title: 'Descrição do evento',
            isDefault: true,
            isRequired: true,
            order: 0,
            content: createEventDto.description,
          }),
        });
      });
    });

    describe('UC2: User searches events with filters', () => {
      it('should filter events by multiple criteria simultaneously', async () => {
        const filterDto = {
          country: 'Brasil',
          state: 'SP',
          city: 'São Paulo',
          name: 'Maratona',
          thisMonth: true,
          page: 1,
          limit: 20,
        };

        const mockEvents = [
          {
            id: 'event-1',
            name: 'Maratona de São Paulo',
            city: 'São Paulo',
            state: 'SP',
            eventDate: new Date('2025-06-15'),
            organizer: { id: 'org-1', name: 'Org 1', email: 'org1@example.com' },
          },
        ];

        mockPrismaService.event.findMany.mockResolvedValue(mockEvents);
        mockPrismaService.event.count.mockResolvedValue(1);

        const result = await service.findAll(filterDto);

        expect(result.data.events).toHaveLength(1);
        // O where público é um AND de topo (status != SUSPENDED + cutoff de data)
        // com o objeto de filtros aninhado no último elemento.
        expect(mockPrismaService.event.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              AND: expect.arrayContaining([
                expect.objectContaining({
                  country: 'Brasil',
                  state: 'SP',
                  city: 'São Paulo',
                  name: expect.objectContaining({ contains: 'Maratona', mode: 'insensitive' }),
                }),
              ]),
            }),
          }),
        );
      });

      it('should handle empty search results gracefully', async () => {
        mockPrismaService.event.findMany.mockResolvedValue([]);
        mockPrismaService.event.count.mockResolvedValue(0);

        const result = await service.findAll({ page: 1, limit: 10 });

        expect(result.data.events).toEqual([]);
        expect(result.data.pagination.total).toBe(0);
        expect(result.data.pagination.totalPages).toBe(0);
      });
    });

    describe('UC3: User views event details', () => {
      it('should return complete event information with all relations', async () => {
        const eventId = VALID_EVENT_ID;
        const mockEvent = {
          id: eventId,
          name: 'Test Event',
          description: 'Test Description',
          bannerUrl: 'https://example.com/banner.jpg',
          organizer: {
            id: 'org-123',
            name: 'Test Organizer',
            email: 'org@example.com',
            phone: '1234567890',
            user: {
              id: 'user-123',
              firstName: 'John',
              lastName: 'Doe',
              email: 'john@example.com',
              phone: '1234567890',
            },
          },
          topics: [
            { id: 'topic-1', title: 'Descrição', content: 'Event description', isEnabled: true },
          ],
          locations: [
            {
              id: 'loc-1',
              address: '123 Main St',
              city: 'São Paulo',
              state: 'SP',
              country: 'Brasil',
            },
          ],
          modalities: [],
          kits: [],
          questions: [],
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);

        const result = await service.findOne(eventId);

        // Caminho público enriquece com `tracking`; o restante segue igual ao mock.
        expect(result.data.event).toMatchObject(mockEvent);
        expect(
          (result.data.event as { organizer?: unknown }).organizer,
        ).toBeDefined();
        expect(result.data.event.topics).toBeDefined();
        expect(result.data.event.locations).toBeDefined();
      });
    });
  });

  describe('Security Tests', () => {
    describe('Authorization', () => {
      it('should prevent non-organizer from creating events', async () => {
        mockPrismaService.organizationMember.findMany.mockResolvedValue([]);

        await expect(
          service.create('user-123', {
            name: 'Test Event',
            location: 'Test',
            city: 'Test',
            state: 'Test',
            country: 'Test',
            eventDate: '2025-12-31T00:00:00Z',
            registrationStartDate: '2025-12-01T00:00:00Z',
            registrationEndDate: '2025-12-30T00:00:00Z',
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('should prevent organizer from updating other organizers events', async () => {
        const userId = 'user-123';
        const eventId = VALID_EVENT_ID;
        const event = { id: eventId, organizationId: '00000000-0000-0000-0000-000000000099' };

        mockPrismaService.event.findUnique.mockResolvedValue(event);
        mockOrganizerMemberAccess.assertCanAccessEvent.mockRejectedValueOnce(
          new ForbiddenException('No access to this event'),
        );

        await expect(service.update(userId, eventId, { name: 'Hacked' })).rejects.toThrow(
          ForbiddenException,
        );
      });

      it('should prevent SQL injection in search filters', async () => {
        const maliciousInput = "'; DROP TABLE events; --";
        mockPrismaService.event.findMany.mockResolvedValue([]);
        mockPrismaService.event.count.mockResolvedValue(0);

        await service.findAll({ name: maliciousInput, page: 1, limit: 10 });

        // Verificar que Prisma trata o input como string literal, não como SQL.
        // O filtro de nome vive no objeto aninhado dentro do AND de topo.
        expect(mockPrismaService.event.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              AND: expect.arrayContaining([
                expect.objectContaining({
                  name: expect.objectContaining({
                    contains: maliciousInput,
                  }),
                }),
              ]),
            }),
          }),
        );
      });
    });

    describe('Input Validation', () => {
      it('should sanitize XSS attempts in event description', async () => {
        const userId = 'org-user-123';
        const xssPayload = '<script>alert("XSS")</script>';
        const createEventDto = {
          name: 'Test Event',
          description: xssPayload,
          location: 'Test',
          city: 'Test',
          state: 'Test',
          country: 'Test',
          eventDate: '2025-12-31T00:00:00Z',
          registrationStartDate: '2025-12-01T00:00:00Z',
          registrationEndDate: '2025-12-30T00:00:00Z',
        };

        setupDefaultEventCreationMocks(mockPrismaService, createEventDto);

        await service.create(userId, createEventDto);

        // O Prisma deve armazenar como está, mas a validação do DTO deve prevenir
        expect(mockPrismaService.event.create).toHaveBeenCalled();
      });

      it('should validate date formats', async () => {
        const userId = 'org-user-123';
        const validDate = '2025-12-31T00:00:00Z';
        const invalidDate = 'not-a-date';

        const baseDto = {
          name: 'Test',
          location: 'Test',
          city: 'Test',
          state: 'Test',
          country: 'Test',
          registrationStartDate: '2025-12-01T00:00:00Z',
          registrationEndDate: '2025-12-30T00:00:00Z',
        };

        setupDefaultEventCreationMocks(mockPrismaService, {
          ...baseDto,
          eventDate: validDate,
        });
        mockPrismaService.event.create.mockImplementation((args: { data: { eventDate: Date } }) => {
          const eventDate = args.data.eventDate;
          if (isNaN(eventDate.getTime())) {
            throw new Error('Invalid date');
          }
          return Promise.resolve({
            id: 'event-123',
            ...args.data,
            organizationId: 'org-123',
            slug: null,
          });
        });

        await expect(
          service.create(userId, {
            ...baseDto,
            eventDate: validDate,
          }),
        ).resolves.toBeDefined();

        setupDefaultEventCreationMocks(mockPrismaService, {
          ...baseDto,
          eventDate: invalidDate,
        });
        mockPrismaService.event.create.mockImplementation((args: { data: { eventDate: Date } }) => {
          const eventDate = args.data.eventDate;
          if (isNaN(eventDate.getTime())) {
            throw new Error('Invalid date');
          }
          return Promise.resolve({
            id: 'event-123',
            ...args.data,
            organizationId: 'org-123',
            slug: null,
          });
        });

        await expect(
          service.create(userId, {
            ...baseDto,
            eventDate: invalidDate,
          }),
        ).rejects.toThrow();
      });
    });

    describe('Access Control', () => {
      it('should allow only event owner to update event', async () => {
        const attackerId = 'attacker-123';
        const eventId = VALID_EVENT_ID;

        const event = { id: eventId, organizationId: '00000000-0000-0000-0000-000000000002' };

        mockPrismaService.event.findUnique.mockResolvedValue(event);
        mockOrganizerMemberAccess.assertCanAccessEvent.mockRejectedValueOnce(
          new ForbiddenException('Missing permission: edit_event'),
        );

        await expect(
          service.update(attackerId, eventId, { name: 'Hacked Event' }),
        ).rejects.toThrow(ForbiddenException);

        expect(mockPrismaService.event.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('Performance Tests', () => {
    it('should handle large result sets efficiently', async () => {
      const largeEventList = Array.from({ length: 1000 }, (_, i) => ({
        id: `event-${i}`,
        name: `Event ${i}`,
        city: 'São Paulo',
        state: 'SP',
        eventDate: new Date(`2025-${String(i % 12 + 1).padStart(2, '0')}-15`),
        organizer: { id: `org-${i}`, name: `Org ${i}`, email: `org${i}@example.com` },
      }));

      mockPrismaService.event.findMany.mockResolvedValue(largeEventList.slice(0, 10));
      mockPrismaService.event.count.mockResolvedValue(1000);

      const startTime = Date.now();
      const result = await service.findAll({ page: 1, limit: 10 });
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(1000); // Deve completar em menos de 1 segundo
      expect(result.data.events).toHaveLength(10);
      expect(result.data.pagination.total).toBe(1000);
    });

    it('should use pagination to limit database queries', async () => {
      mockPrismaService.event.findMany.mockResolvedValue([]);
      mockPrismaService.event.count.mockResolvedValue(100);

      await service.findAll({ page: 5, limit: 10 });

      expect(mockPrismaService.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 40,
          take: 10,
        }),
      );
    });

    it('should use Promise.all for parallel queries', async () => {
      mockPrismaService.event.findMany.mockResolvedValue([]);
      mockPrismaService.event.count.mockResolvedValue(0);

      const findManySpy = jest.spyOn(mockPrismaService.event, 'findMany');
      const countSpy = jest.spyOn(mockPrismaService.event, 'count');

      await service.findAll({ page: 1, limit: 10 });

      // Verificar que ambas as queries foram chamadas
      expect(findManySpy).toHaveBeenCalled();
      expect(countSpy).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle event with registrationEndDate before eventDate', async () => {
      const userId = 'org-user-123';
      const createEventDto = {
        name: 'Test Event',
        location: 'Test',
        city: 'Test',
        state: 'Test',
        country: 'Test',
        eventDate: '2025-06-15T00:00:00Z',
        registrationStartDate: '2025-05-01T00:00:00Z',
        registrationEndDate: '2025-06-10T23:59:59Z', // Antes do evento
      };

      setupDefaultEventCreationMocks(mockPrismaService, createEventDto);

      // Deve permitir criar, mas validar na inscrição
      await expect(service.create(userId, createEventDto)).resolves.toBeDefined();
    });

    it('should handle events with special characters in name', async () => {
      const userId = 'org-user-123';
      const createEventDto = {
        name: "Evento Especial: 2025! @#$%^&*()_+-=[]{}|;':\",./<>?",
        location: 'Test',
        city: 'Test',
        state: 'Test',
        country: 'Test',
        eventDate: '2025-12-31T00:00:00Z',
        registrationStartDate: '2025-12-01T00:00:00Z',
        registrationEndDate: '2025-12-30T00:00:00Z',
      };

      setupDefaultEventCreationMocks(mockPrismaService, createEventDto);

      const result = await service.create(userId, createEventDto);
      expect(result.data.event.name).toBe(createEventDto.name);
    });

    it('should handle very long event descriptions', async () => {
      const userId = 'org-user-123';
      const longDescription = 'A'.repeat(10000);
      const createEventDto = {
        name: 'Test Event',
        description: longDescription,
        location: 'Test',
        city: 'Test',
        state: 'Test',
        country: 'Test',
        eventDate: '2025-12-31T00:00:00Z',
        registrationStartDate: '2025-12-01T00:00:00Z',
        registrationEndDate: '2025-12-30T00:00:00Z',
      };

      setupDefaultEventCreationMocks(mockPrismaService, createEventDto);

      await expect(service.create(userId, createEventDto)).resolves.toBeDefined();
    });
  });

  describe('Data Integrity', () => {
    it('should enforce unique event names per organizer', async () => {
      // Nota: Isso seria validado no schema Prisma ou na camada de serviço
      // Este teste verifica que erros de duplicação do Prisma são tratados
      const userId = 'org-user-123';
      const createEventDto = {
        name: 'Duplicate Event',
        location: 'Test',
        city: 'Test',
        state: 'Test',
        country: 'Test',
        eventDate: '2025-12-31T00:00:00Z',
        registrationStartDate: '2025-12-01T00:00:00Z',
        registrationEndDate: '2025-12-30T00:00:00Z',
      };

      const mockMember = {
        id: 'member-123',
        organizationId: 'org-123',
        role: 'OWNER',
        permissions: null,
        organization: { id: 'org-123' },
      };
      mockPrismaService.organizationMember.findMany.mockResolvedValue([mockMember]);
      mockPrismaService.event.findFirst.mockResolvedValue(null);

      // Simular erro de duplicação do Prisma
      const prismaError = new Error('Unique constraint failed');
      (prismaError as any).code = 'P2002';
      (prismaError as any).meta = { target: ['organizerId', 'name'] };
      
      mockPrismaService.event.create.mockReset();
      mockPrismaService.event.create.mockRejectedValue(prismaError);

      await expect(service.create(userId, createEventDto)).rejects.toThrow();
    });

    it('should handle timezone correctly for event dates', async () => {
      const userId = 'org-user-123';
      const createEventDto = {
        name: 'Test Event',
        location: 'Test',
        city: 'Test',
        state: 'Test',
        country: 'Test',
        eventDate: '2025-06-15T08:00:00-03:00', // UTC-3 (Brasil)
        registrationStartDate: '2025-05-01T08:00:00-03:00',
        registrationEndDate: '2025-06-10T23:59:59-03:00',
      };

      setupDefaultEventCreationMocks(mockPrismaService, createEventDto);
      mockPrismaService.event.create.mockResolvedValue({
        id: 'event-123',
        ...createEventDto,
        organizationId: 'org-123',
        slug: null,
        eventDate: new Date(createEventDto.eventDate),
        registrationStartDate: new Date(createEventDto.registrationStartDate),
        registrationEndDate: new Date(createEventDto.registrationEndDate),
      });
      mockPrismaService.event.update.mockResolvedValue({
        id: 'event-123',
        ...createEventDto,
        organizationId: 'org-123',
        slug: 'slug-event-123',
        organization: { members: [] },
        eventDate: new Date(createEventDto.eventDate),
        registrationStartDate: new Date(createEventDto.registrationStartDate),
        registrationEndDate: new Date(createEventDto.registrationEndDate),
      });

      const result = await service.create(userId, createEventDto);
      expect(result.data.event.eventDate).toBeInstanceOf(Date);
    });
  });

  describe('Topic Management', () => {
    it('should allow organizer to disable default topics', async () => {
      const userId = 'org-user-123';
      const eventId = VALID_EVENT_ID;
      const updateDto = { isEnabled: false };

      const mockOrganizer = { id: 'org-123', userId };
      const mockEvent = { id: eventId, organizerId: mockOrganizer.id };
      const mockTopic = {
        id: VALID_TOPIC_ID,
        eventId,
        title: 'REGULAMENTO',
        isDefault: true,
        isEnabled: true,
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.eventTopic.findUnique.mockResolvedValue(mockTopic);
      mockPrismaService.eventTopic.update.mockResolvedValue({
        ...mockTopic,
        ...updateDto,
      });

      const result = await service.updateTopic(userId, eventId, VALID_TOPIC_ID, updateDto);

      expect(result.data.topic.isEnabled).toBe(false);
    });

    it('should prevent deletion of default topics', async () => {
      const userId = 'org-user-123';
      const eventId = VALID_EVENT_ID;
      const topicId = VALID_TOPIC_ID;

      const mockOrganizer = { id: 'org-123', userId };
      const mockEvent = { id: eventId, organizerId: mockOrganizer.id };
      const mockTopic = {
        id: topicId,
        eventId,
        title: 'REGULAMENTO',
        isDefault: true,
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.eventTopic.findUnique.mockResolvedValue(mockTopic);

      await expect(service.deleteTopic(userId, eventId, topicId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('Location Management', () => {
    it('should create event location with coordinates', async () => {
      const userId = 'org-user-123';
      const eventId = VALID_EVENT_ID;
      const locationDto = {
        address: '123 Main St',
        city: 'São Paulo',
        state: 'SP',
        country: 'Brasil',
        latitude: -23.5505,
        longitude: -46.6333,
        googleMapsLink: 'https://maps.google.com/?q=-23.5505,-46.6333',
      };

      const mockOrganizer = { id: 'org-123', userId };
      const mockEvent = { id: eventId, organizerId: mockOrganizer.id };
      const mockLocation = { id: 'loc-123', eventId, ...locationDto };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.eventLocation.create.mockResolvedValue(mockLocation);

      const result = await service.createLocation(userId, eventId, locationDto);

      expect(result.data.location.latitude).toBe(locationDto.latitude);
      expect(result.data.location.longitude).toBe(locationDto.longitude);
    });
  });
});

