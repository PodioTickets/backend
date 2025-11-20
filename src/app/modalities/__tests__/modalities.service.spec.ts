import { Test, TestingModule } from '@nestjs/testing';
import { ModalitiesService } from '../modalities.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('ModalitiesService', () => {
  let service: ModalitiesService;
  let prisma: PrismaService;

  const mockPrismaService = {
    organizer: {
      findUnique: jest.fn(),
    },
    event: {
      findUnique: jest.fn(),
    },
    modalityGroup: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    modality: {
      create: jest.fn(),
      findUnique: jest.fn(),
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
        ModalitiesService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<ModalitiesService>(ModalitiesService);
    prisma = module.get<PrismaService>(PrismaService);

    // Mock getReadClient and getWriteClient to return the same mock
    mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
    mockPrismaService.getWriteClient.mockReturnValue(mockPrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createGroup', () => {
    it('should create a modality group successfully', async () => {
      const userId = 'user-123';
      const eventId = 'event-123';
      const createDto = {
        name: 'Running',
        description: 'Running modalities',
      };

      const mockOrganizer = { id: 'org-123', userId };
      const mockEvent = { id: eventId, organizerId: mockOrganizer.id };
      const mockGroup = {
        id: 'group-123',
        eventId,
        ...createDto,
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.modalityGroup.create.mockResolvedValue(mockGroup);

      const result = await service.createGroup(userId, eventId, createDto);

      expect(result.message).toBe('Modality group created successfully');
      expect(result.data.group).toEqual(mockGroup);
    });
  });

  describe('create', () => {
    it('should create a modality successfully', async () => {
      const userId = 'user-123';
      const eventId = 'event-123';
      const createDto = {
        groupId: 'group-123',
        name: '5K Run',
        price: 50,
        isActive: true,
      };

      const mockOrganizer = { id: 'org-123', userId };
      const mockEvent = { id: eventId, organizerId: mockOrganizer.id };
      const mockGroup = { id: 'group-123', eventId };
      const mockModality = {
        id: 'mod-123',
        eventId,
        ...createDto,
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.modalityGroup.findUnique.mockResolvedValue(mockGroup);
      mockPrismaService.modality.create.mockResolvedValue(mockModality);

      const result = await service.create(userId, eventId, createDto);

      expect(result.message).toBe('Modality created successfully');
      expect(result.data.modality).toEqual(mockModality);
    });
  });

  describe('findAll', () => {
    it('should return all modalities for an event', async () => {
      const eventId = 'event-123';
      const mockModalities = [
        {
          id: 'mod-123',
          eventId,
          name: '5K Run',
          price: 50,
          group: { name: 'Running' },
        },
      ];

      mockPrismaService.modality.findMany.mockResolvedValue(mockModalities);

      const result = await service.findAll(eventId);

      expect(result.message).toBe('Modalities fetched successfully');
      expect(result.data.modalities).toEqual(mockModalities);
    });
  });

  describe('findOne', () => {
    it('should return a modality by id', async () => {
      const modalityId = 'mod-123';
      const mockModality = {
        id: modalityId,
        name: '5K Run',
        price: 50,
        group: { name: 'Running' },
        event: { id: 'event-123', name: 'Test Event' },
      };

      mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);

      const result = await service.findOne(modalityId);

      expect(result.message).toBe('Modality fetched successfully');
      expect(result.data.modality).toEqual(mockModality);
    });

    it('should throw NotFoundException if modality not found', async () => {
      mockPrismaService.modality.findUnique.mockResolvedValue(null);

      await expect(service.findOne('invalid-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update a modality successfully', async () => {
      const userId = 'user-123';
      const eventId = 'event-123';
      const modalityId = 'mod-123';
      const updateDto = { price: 60 };

      const mockOrganizer = { id: 'org-123', userId };
      const mockEvent = { id: eventId, organizerId: mockOrganizer.id };
      const mockModality = {
        id: modalityId,
        eventId,
        ...updateDto,
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);
      mockPrismaService.modality.update.mockResolvedValue(mockModality);

      const result = await service.update(userId, eventId, modalityId, updateDto);

      expect(result.message).toBe('Modality updated successfully');
      expect(result.data.modality).toEqual(mockModality);
    });
  });

  describe('remove', () => {
    it('should remove a modality successfully', async () => {
      const userId = 'user-123';
      const eventId = 'event-123';
      const modalityId = 'mod-123';

      const mockOrganizer = { id: 'org-123', userId };
      const mockEvent = { id: eventId, organizerId: mockOrganizer.id };
      const mockModality = {
        id: modalityId,
        eventId,
        registrations: [],
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);
      mockPrismaService.modality.delete.mockResolvedValue(mockModality);

      const result = await service.remove(userId, eventId, modalityId);

      expect(result.message).toBe('Modality deleted successfully');
    });

    it('should throw BadRequestException if modality has registrations', async () => {
      const mockOrganizer = { id: 'org-123', userId: 'user-123' };
      const mockEvent = { id: 'event-123', organizerId: mockOrganizer.id };
      const mockModality = {
        id: 'mod-123',
        eventId: 'event-123',
        registrations: [{ id: 'reg-123' }],
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);

      await expect(
        service.remove('user-123', 'event-123', 'mod-123'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

