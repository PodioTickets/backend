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
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { EventStatus, PaymentStatus } from '@prisma/client';

describe('EventsService', () => {
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
    organizationMemberEventAccess: {
      upsert: jest.fn(),
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
    event: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    order: {
      groupBy: jest.fn(),
    },
    // findByOrganizer agora calcula a receita LÍQUIDA por evento via $queryRaw
    // (não mais order.groupBy de finalAmount bruto).
    $queryRaw: jest.fn().mockResolvedValue([]),
    eventTopic: {
      create: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    eventLocation: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
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

    // Mock getReadClient and getWriteClient to return the same mock
    mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
    mockPrismaService.getWriteClient.mockReturnValue(mockPrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create an event successfully', async () => {
      const userId = 'user-123';
      const createEventDto = {
        name: 'Test Event',
        description: 'Test Description',
        location: 'Test Location',
        city: 'São Paulo',
        state: 'SP',
        country: 'Brasil',
        eventDate: '2024-12-31T00:00:00Z',
        registrationStartDate: '2024-12-01T00:00:00Z',
        registrationEndDate: '2024-12-30T00:00:00Z',
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
        slug: 'test-event-event-123',
        organization: { members: [] },
      };
      const mockTopics = [
        {
          id: 'topic-1',
          eventId: 'event-123',
          title: 'Descrição do evento',
          content: 'Test Description',
          isDefault: true,
          isRequired: true,
          order: 0,
        },
      ];

      mockPrismaService.organizationMember.findMany.mockResolvedValue([mockMember]);
      mockPrismaService.event.findFirst.mockResolvedValue(null);
      mockPrismaService.event.create.mockResolvedValue(mockEvent);
      mockPrismaService.event.update.mockResolvedValue(mockUpdated);
      mockPrismaService.eventTopic.create.mockResolvedValue(mockTopics[0]);
      mockPrismaService.eventTopic.findMany.mockResolvedValue(mockTopics);

      const result = await service.create(userId, createEventDto);

      expect(result.message).toBe('Event created successfully');
      expect(result.data.event.topics).toEqual(mockTopics);
      // O tópico padrão de descrição é criado por ensureDefaultDescriptionTopic
      // com o conteúdo trimado da descrição do evento.
      expect(mockPrismaService.eventTopic.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventId: 'event-123',
          title: 'Descrição do evento',
          content: 'Test Description',
          isDefault: true,
          isRequired: true,
          order: 0,
        }),
      });
    });

    it('should throw BadRequestException if user is not an organization owner', async () => {
      const userId = 'user-123';
      mockPrismaService.organizationMember.findMany.mockResolvedValue([]);

      await expect(
        service.create(userId, {
          name: 'Test',
          location: 'Test',
          city: 'Test',
          state: 'Test',
          country: 'Test',
          eventDate: '2024-12-31T00:00:00Z',
          registrationStartDate: '2024-12-01T00:00:00Z',
          registrationEndDate: '2024-12-30T00:00:00Z',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('should return paginated events', async () => {
      const mockEvents = [
        {
          id: 'event-1',
          name: 'Event 1',
          city: 'São Paulo',
          state: 'SP',
          eventDate: new Date('2024-12-31'),
        },
      ];

      mockPrismaService.event.findMany.mockResolvedValue(mockEvents);
      mockPrismaService.event.count.mockResolvedValue(1);

      // includeHasSlots:false evita o enriquecimento de slots (que adiciona
      // hasRegistrationSlotsAvailable), mantendo o payload igual ao mock.
      const result = await service.findAll({
        page: 1,
        limit: 10,
        includeHasSlots: false,
      });

      expect(result.message).toBe('Events fetched successfully');
      // withPastEventsAsCompleted marca eventos com data passada como COMPLETED
      // (o mock usa 2024-12-31, no passado); o restante do payload é preservado.
      expect(result.data.events).toEqual(
        mockEvents.map((e) => ({ ...e, status: EventStatus.COMPLETED })),
      );
      expect(result.data.pagination.total).toBe(1);
    });

    it('should filter events by city', async () => {
      mockPrismaService.event.findMany.mockResolvedValue([]);
      mockPrismaService.event.count.mockResolvedValue(0);

      await service.findAll({ city: 'São Paulo', page: 1, limit: 10 });

      // O where público agora é um AND de topo (status != SUSPENDED + cutoff de data)
      // com o where dos filtros aninhado; a cidade vive nesse objeto interno.
      expect(mockPrismaService.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({ city: 'São Paulo' }),
            ]),
          }),
        }),
      );
    });
  });

  describe('findByOrganizer', () => {
    const futureDate = new Date('2099-06-15T12:00:00.000Z');

    const baseEventRow = (id: string, name: string) => ({
      id,
      name,
      description: null,
      bannerUrl: null,
      logoUrl: null,
      slug: `${id}-slug`,
      location: null,
      city: 'SP',
      state: 'SP',
      country: 'BR',
      eventDate: futureDate,
      registrationEndDate: futureDate,
      status: EventStatus.PUBLISHED,
      createdAt: futureDate,
      updatedAt: futureDate,
      _count: { registrations: 0, modalities: 0 },
    });

    beforeEach(() => {
      mockOrganizerMemberAccess.getMemberForOrganizerUser.mockResolvedValue({
        organizationId: 'org-1',
      });
      mockOrganizerMemberAccess.buildOrganizerEventsWhere.mockReturnValue({
        organizationId: 'org-1',
      });
    });

    it('agrega a receita LÍQUIDA por evento via uma única $queryRaw (não bruto)', async () => {
      const ev1 = baseEventRow('e1111111-1111-1111-1111-111111111111', 'Event A');
      const ev2 = baseEventRow('e2222222-2222-2222-2222-222222222222', 'Event B');
      mockPrismaService.event.findMany.mockResolvedValue([ev1, ev2]);
      mockPrismaService.event.count.mockResolvedValue(2);
      // SQL já devolve o líquido (centavos) por eventId.
      mockPrismaService.$queryRaw.mockResolvedValue([
        { eventId: ev1.id, net: BigInt(9_000) },
        { eventId: ev2.id, net: BigInt(2_250) },
      ]);

      const result = await service.findByOrganizer('user-1', { page: 1, limit: 20 });

      // Uma única request de agregação (não N).
      expect(mockPrismaService.$queryRaw).toHaveBeenCalledTimes(1);
      // O líquido (não o finalAmount bruto via groupBy) é o que vai pra totalSales.
      expect(mockPrismaService.order.groupBy).not.toHaveBeenCalled();
      expect(result.data.events).toHaveLength(2);
      expect(result.data.events[0].totalSales).toBe(9_000);
      expect(result.data.events[1].totalSales).toBe(2_250);
    });

    it('não consulta a receita quando a página não tem eventos', async () => {
      mockPrismaService.event.findMany.mockResolvedValue([]);
      mockPrismaService.event.count.mockResolvedValue(0);

      await service.findByOrganizer('user-1', { page: 1, limit: 20 });

      expect(mockPrismaService.$queryRaw).not.toHaveBeenCalled();
    });

    it('retorna totalSales 0 quando não há pedidos pagos para os eventos listados', async () => {
      const ev1 = baseEventRow('e3333333-3333-3333-3333-333333333333', 'Lonely');
      mockPrismaService.event.findMany.mockResolvedValue([ev1]);
      mockPrismaService.event.count.mockResolvedValue(1);
      mockPrismaService.$queryRaw.mockResolvedValue([]);

      const result = await service.findByOrganizer('user-1', { page: 1, limit: 10 });

      expect(mockPrismaService.$queryRaw).toHaveBeenCalledTimes(1);
      expect(result.data.events[0].totalSales).toBe(0);
    });
  });

  describe('findOne', () => {
    const validEventId = 'e1111111-1111-1111-1111-111111111111';

    it('should return an event by id', async () => {
      const mockEvent = {
        id: validEventId,
        name: 'Test Event',
        organizer: { name: 'Test Organizer' },
        topics: [],
        locations: [],
        modalities: [],
        kits: [],
        questions: [],
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);

      const result = await service.findOne(validEventId);

      expect(result.message).toBe('Event fetched successfully');
      // O caminho público enriquece o evento com `tracking` (Meta/GA/Ads) via
      // withTracking; o restante do payload permanece igual ao mock.
      expect(result.data.event).toMatchObject(mockEvent);
      expect((result.data.event as any).tracking).toBeDefined();
    });

    it('should throw NotFoundException if event not found', async () => {
      mockPrismaService.event.findUnique.mockResolvedValue(null);

      await expect(service.findOne(validEventId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    const validEventId = 'e1111111-1111-1111-1111-111111111111';

    it('should update an event successfully', async () => {
      const userId = 'user-123';
      const eventId = validEventId;
      const updateDto = { name: 'Updated Event' };

      const mockOrganizer = { id: 'org-123', userId };
      const mockEvent = {
        id: eventId,
        organizationId: '00000000-0000-0000-0000-000000000001',
        organizerId: mockOrganizer.id,
        slug: 'old-slug',
        name: 'Updated Event',
        ...updateDto,
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      // slugExists (via generateEventSlug) consulta event.findFirst.
      mockPrismaService.event.findFirst.mockResolvedValue(null);
      mockPrismaService.event.update.mockResolvedValue(mockEvent);

      const result = await service.update(userId, eventId, updateDto);

      expect(result.message).toBe('Event updated successfully');
      expect(result.data.event).toEqual(mockEvent);
    });

    it('should throw NotFoundException if event not found', async () => {
      mockPrismaService.organizer.findUnique.mockResolvedValue({ id: 'org-123' });
      mockPrismaService.event.findUnique.mockResolvedValue(null);

      await expect(
        service.update('user-123', validEventId, { name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('createTopic', () => {
    it('should create an event topic', async () => {
      const userId = 'user-123';
      const eventId = 'e1111111-1111-1111-1111-111111111111';
      const topicDto = {
        title: 'New Topic',
        content: 'Topic content',
      };

      const mockOrganizer = { id: 'org-123', userId };
      const mockEvent = { id: eventId, organizerId: mockOrganizer.id };
      const mockTopic = { id: 'topic-123', eventId, ...topicDto };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.eventTopic.create.mockResolvedValue(mockTopic);

      const result = await service.createTopic(userId, eventId, topicDto);

      expect(result.message).toBe('Topic created successfully');
      expect(result.data.topic).toEqual(mockTopic);
    });
  });
});

