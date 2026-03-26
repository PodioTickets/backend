import { Test, TestingModule } from '@nestjs/testing';
import { EventsService } from '../events.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrganizerMemberAccessService } from '../../organizations/organizer-member-access.service';
import { OrganizationsService } from '../../organizations/organizations.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { EventStatus } from '@prisma/client';

describe('EventsService', () => {
  let service: EventsService;
  let prisma: PrismaService;

  const mockPrismaService = {
    organizer: {
      findUnique: jest.fn(),
    },
    organizationMember: {
      findFirst: jest.fn(),
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
        organizationId: 'org-123',
        role: 'OWNER',
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

      mockPrismaService.organizationMember.findFirst.mockResolvedValue(mockMember);
      mockPrismaService.event.findFirst.mockResolvedValue(null);
      mockPrismaService.event.create.mockResolvedValue(mockEvent);
      mockPrismaService.event.update.mockResolvedValue(mockUpdated);
      mockPrismaService.eventTopic.create.mockResolvedValue(mockTopics[0]);
      mockPrismaService.eventTopic.findMany.mockResolvedValue(mockTopics);

      const result = await service.create(userId, createEventDto);

      expect(result.message).toBe('Event created successfully');
      expect(result.data.event.topics).toEqual(mockTopics);
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
      mockPrismaService.organizationMember.findFirst.mockResolvedValue(null);

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

      const result = await service.findAll({ page: 1, limit: 10 });

      expect(result.message).toBe('Events fetched successfully');
      expect(result.data.events).toEqual(mockEvents);
      expect(result.data.pagination.total).toBe(1);
    });

    it('should filter events by city', async () => {
      mockPrismaService.event.findMany.mockResolvedValue([]);
      mockPrismaService.event.count.mockResolvedValue(0);

      await service.findAll({ city: 'São Paulo', page: 1, limit: 10 });

      expect(mockPrismaService.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            city: 'São Paulo',
          }),
        }),
      );
    });
  });

  describe('findOne', () => {
    it('should return an event by id', async () => {
      const mockEvent = {
        id: 'event-123',
        name: 'Test Event',
        organizer: { name: 'Test Organizer' },
        topics: [],
        locations: [],
        modalities: [],
        kits: [],
        questions: [],
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);

      const result = await service.findOne('event-123');

      expect(result.message).toBe('Event fetched successfully');
      expect(result.data.event).toEqual(mockEvent);
    });

    it('should throw NotFoundException if event not found', async () => {
      mockPrismaService.event.findUnique.mockResolvedValue(null);

      await expect(service.findOne('invalid-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update an event successfully', async () => {
      const userId = 'user-123';
      const eventId = 'event-123';
      const updateDto = { name: 'Updated Event' };

      const mockOrganizer = { id: 'org-123', userId };
      const mockEvent = {
        id: eventId,
        organizationId: '00000000-0000-0000-0000-000000000001',
        organizerId: mockOrganizer.id,
        name: 'Updated Event',
        ...updateDto,
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.event.update.mockResolvedValue(mockEvent);

      const result = await service.update(userId, eventId, updateDto);

      expect(result.message).toBe('Event updated successfully');
      expect(result.data.event).toEqual(mockEvent);
    });

    it('should throw NotFoundException if event not found', async () => {
      mockPrismaService.organizer.findUnique.mockResolvedValue({ id: 'org-123' });
      mockPrismaService.event.findUnique.mockResolvedValue(null);

      await expect(
        service.update('user-123', 'invalid-id', {}),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('createTopic', () => {
    it('should create an event topic', async () => {
      const userId = 'user-123';
      const eventId = 'event-123';
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

