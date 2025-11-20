import { Test, TestingModule } from '@nestjs/testing';
import { KitsService } from '../kits.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('KitsService', () => {
  let service: KitsService;
  let prisma: PrismaService;

  const mockPrismaService = {
    organizer: {
      findUnique: jest.fn(),
    },
    event: {
      findUnique: jest.fn(),
    },
    kit: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    kitItem: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    getReadClient: jest.fn(),
    getWriteClient: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KitsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<KitsService>(KitsService);
    prisma = module.get<PrismaService>(PrismaService);

    // Mock getReadClient and getWriteClient to return the same mock
    mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
    mockPrismaService.getWriteClient.mockReturnValue(mockPrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a kit successfully', async () => {
      const userId = 'user-123';
      const eventId = 'event-123';
      const createDto = {
        name: 'Test Kit',
        description: 'Test Description',
        isActive: true,
        items: [],
      };

      const mockOrganizer = { id: 'org-123', userId };
      const mockEvent = { id: eventId, organizerId: mockOrganizer.id };
      const mockKit = {
        id: 'kit-123',
        eventId,
        ...createDto,
        items: [],
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.kit.create.mockResolvedValue(mockKit);

      const result = await service.create(userId, eventId, createDto);

      expect(result.message).toBe('Kit created successfully');
      expect(result.data.kit).toEqual(mockKit);
    });

    it('should throw BadRequestException if user is not organizer', async () => {
      mockPrismaService.organizer.findUnique.mockResolvedValue(null);

      await expect(
        service.create('user-123', 'event-123', {
          name: 'Test Kit',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('should return all kits for an event', async () => {
      const eventId = 'event-123';
      const mockKits = [
        {
          id: 'kit-123',
          eventId,
          name: 'Test Kit',
          items: [],
        },
      ];

      mockPrismaService.kit.findMany.mockResolvedValue(mockKits);

      const result = await service.findAll(eventId);

      expect(result.message).toBe('Kits fetched successfully');
      expect(result.data.kits).toEqual(mockKits);
    });
  });

  describe('findOne', () => {
    it('should return a kit by id', async () => {
      const kitId = 'kit-123';
      const mockKit = {
        id: kitId,
        name: 'Test Kit',
        items: [],
        event: { id: 'event-123', name: 'Test Event' },
      };

      mockPrismaService.kit.findUnique.mockResolvedValue(mockKit);

      const result = await service.findOne(kitId);

      expect(result.message).toBe('Kit fetched successfully');
      expect(result.data.kit).toEqual(mockKit);
    });

    it('should throw NotFoundException if kit not found', async () => {
      mockPrismaService.kit.findUnique.mockResolvedValue(null);

      await expect(service.findOne('invalid-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('checkStock', () => {
    it('should check stock successfully', async () => {
      const kitItemId = 'item-123';
      const size = 'M';
      const quantity = 1;

      const mockItem = {
        id: kitItemId,
        sizes: [{ size: 'M', stock: 10 }],
      };

      mockPrismaService.kitItem.findUnique.mockResolvedValue(mockItem);

      const result = await service.checkStock(kitItemId, size, quantity);

      expect(result).toBe(true);
    });

    it('should throw BadRequestException if insufficient stock', async () => {
      const mockItem = {
        id: 'item-123',
        sizes: [{ size: 'M', stock: 0 }],
      };

      mockPrismaService.kitItem.findUnique.mockResolvedValue(mockItem);

      await expect(service.checkStock('item-123', 'M', 1)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('updateStock', () => {
    it('should update stock successfully', async () => {
      const kitItemId = 'item-123';
      const size = 'M';
      const quantity = 1;

      const mockItem = {
        id: kitItemId,
        sizes: [{ size: 'M', stock: 10 }],
      };

      mockPrismaService.kitItem.findUnique.mockResolvedValue(mockItem);
      mockPrismaService.kitItem.update.mockResolvedValue({
        ...mockItem,
        sizes: [{ size: 'M', stock: 9 }],
      });

      await service.updateStock(kitItemId, size, quantity);

      expect(mockPrismaService.kitItem.update).toHaveBeenCalled();
    });
  });
});

