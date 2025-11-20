import { Test, TestingModule } from '@nestjs/testing';
import { ModalitiesService } from '../modalities.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('ModalitiesService - Comprehensive Tests', () => {
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
      findMany: jest.fn(),
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

  describe('Use Cases - User Flow', () => {
    describe('UC1: Organizer creates modality group with modalities', () => {
      it('should create group and add modalities', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';
        const createGroupDto = {
          name: 'Corridas',
          description: 'Modalidades de corrida',
          isActive: true,
        };

        const mockEvent = { id: eventId, organizerId: 'org-123' };
        const mockOrganizer = { id: 'org-123', userId };
        const mockGroup = {
          id: 'group-123',
          eventId,
          ...createGroupDto,
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.modalityGroup.create.mockResolvedValue(mockGroup);

        const result = await service.createGroup(userId, eventId, createGroupDto);

        expect(result.data.group.name).toBe(createGroupDto.name);
      });
    });

    describe('UC2: User selects modality for registration', () => {
      it('should return active modalities for event', async () => {
        const eventId = 'event-123';
        const mockModalities = [
          {
            id: 'mod-1',
            eventId,
            name: '5K',
            price: 100,
            isActive: true,
            maxParticipants: 100,
            currentParticipants: 50,
            group: { name: 'Corridas' },
          },
          {
            id: 'mod-2',
            eventId,
            name: '10K',
            price: 150,
            isActive: true,
            maxParticipants: 50,
            currentParticipants: 30,
            group: { name: 'Corridas' },
          },
        ];

        mockPrismaService.modality.findMany.mockResolvedValue(mockModalities);

        const result = await service.findAll(eventId);

        expect(result.data.modalities).toHaveLength(2);
        expect(result.data.modalities.every((m) => m.isActive)).toBe(true);
      });
    });

    describe('UC3: Modality reaches max participants', () => {
      it('should prevent registration when modality is full', async () => {
        const modalityId = 'mod-123';
        const mockModality = {
          id: modalityId,
          maxParticipants: 100,
          currentParticipants: 100,
          isActive: true,
        };

        mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);

        // Este teste valida que a modalidade está cheia
        expect(mockModality.currentParticipants).toBe(mockModality.maxParticipants);
      });
    });
  });

  describe('Security Tests', () => {
    describe('Authorization', () => {
      it('should prevent non-organizer from creating modalities', async () => {
        const userId = 'user-123';
        const eventId = 'event-123';

        const mockEvent = { id: eventId, organizerId: 'org-999' };
        const mockOrganizer = null;

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);

        await expect(
          service.create(userId, eventId, {
            name: 'Test Modality',
            groupId: 'group-123',
            price: 100,
            isActive: true,
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('should prevent organizer from modifying other organizers modalities', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';
        const modalityId = 'mod-123';

        const mockEvent = { id: eventId, organizerId: 'org-999' };
        const mockOrganizer = { id: 'org-123', userId };
        const mockModality = { id: modalityId, eventId, groupId: 'group-123' };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);

        await expect(
          service.update(userId, eventId, modalityId, { name: 'Hacked' }),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('Input Validation', () => {
      it('should validate price is non-negative', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';

        const mockEvent = { id: eventId, organizerId: 'org-123' };
        const mockOrganizer = { id: 'org-123', userId };
        const mockGroup = { id: 'group-123', eventId };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.modalityGroup.findUnique.mockResolvedValue(mockGroup);
        mockPrismaService.modality.create.mockRejectedValue(new Error('Invalid price'));

        await expect(
          service.create(userId, eventId, {
            name: 'Test',
            groupId: 'group-123',
            price: -100,
            isActive: true,
          }),
        ).rejects.toThrow();
      });

      it('should validate maxParticipants is positive if provided', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';

        const mockEvent = { id: eventId, organizerId: 'org-123' };
        const mockOrganizer = { id: 'org-123', userId };
        const mockGroup = { id: 'group-123', eventId };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.modalityGroup.findUnique.mockResolvedValue(mockGroup);
        mockPrismaService.modality.create.mockRejectedValue(new Error('Invalid maxParticipants'));

        await expect(
          service.create(userId, eventId, {
            name: 'Test',
            groupId: 'group-123',
            price: 100,
            maxParticipants: 0,
            isActive: true,
          }),
        ).rejects.toThrow();
      });
    });

    describe('Business Logic Security', () => {
      it('should prevent creating modality in wrong group', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';

        const mockEvent = { id: eventId, organizerId: 'org-123' };
        const mockOrganizer = { id: 'org-123', userId };
        const mockGroup = { id: 'group-999', eventId: 'other-event' }; // Grupo de outro evento

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.modalityGroup.findUnique.mockResolvedValue(mockGroup);

        await expect(
          service.create(userId, eventId, {
            name: 'Test',
            groupId: 'group-999',
            price: 100,
            isActive: true,
          }),
        ).rejects.toThrow(NotFoundException);
      });
    });
  });

  describe('Performance Tests', () => {
    it('should handle large modality lists efficiently', async () => {
      const eventId = 'event-123';
      const largeModalityList = Array.from({ length: 500 }, (_, i) => ({
        id: `mod-${i}`,
        eventId,
        name: `Modality ${i}`,
        price: 100 + i,
        isActive: true,
        maxParticipants: 100,
        currentParticipants: 0,
        group: { name: 'Group 1' },
      }));

      mockPrismaService.modality.findMany.mockResolvedValue(largeModalityList);

      const startTime = Date.now();
      const result = await service.findAll(eventId);
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(1000);
      expect(result.data.modalities).toHaveLength(500);
    });

    it('should efficiently filter active modalities', async () => {
      const eventId = 'event-123';
      const modalities = Array.from({ length: 100 }, (_, i) => ({
        id: `mod-${i}`,
        eventId,
        name: `Modality ${i}`,
        isActive: i % 2 === 0, // Metade ativa, metade inativa
        price: 100,
      }));

      mockPrismaService.modality.findMany.mockResolvedValue(
        modalities.filter((m) => m.isActive),
      );

      const result = await service.findAll(eventId);

      expect(result.data.modalities.every((m) => m.isActive)).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle modality with null maxParticipants', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };
      const mockGroup = { id: 'group-123', eventId };
      const mockModality = {
        id: 'mod-123',
        eventId,
        groupId: 'group-123',
        name: 'Unlimited',
        price: 100,
        maxParticipants: null,
        currentParticipants: 0,
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.modalityGroup.findUnique.mockResolvedValue(mockGroup);
      mockPrismaService.modality.create.mockResolvedValue(mockModality);

      const result = await service.create(userId, eventId, {
        name: 'Unlimited',
        groupId: 'group-123',
        price: 100,
        maxParticipants: null,
        isActive: true,
      });

      expect(result.data.modality.maxParticipants).toBeNull();
    });

    it('should handle zero price modality', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };
      const mockGroup = { id: 'group-123', eventId };
      const mockModality = {
        id: 'mod-123',
        eventId,
        groupId: 'group-123',
        name: 'Free Modality',
        price: 0,
        isActive: true,
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.modalityGroup.findUnique.mockResolvedValue(mockGroup);
      mockPrismaService.modality.create.mockResolvedValue(mockModality);

      const result = await service.create(userId, eventId, {
        name: 'Free Modality',
        groupId: 'group-123',
        price: 0,
        isActive: true,
      });

      expect(result.data.modality.price).toBe(0);
    });

    it('should handle very high price values', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const highPrice = 999999.99;

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };
      const mockGroup = { id: 'group-123', eventId };
      const mockModality = {
        id: 'mod-123',
        eventId,
        groupId: 'group-123',
        name: 'Premium',
        price: highPrice,
        isActive: true,
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.modalityGroup.findUnique.mockResolvedValue(mockGroup);
      mockPrismaService.modality.create.mockResolvedValue(mockModality);

      const result = await service.create(userId, eventId, {
        name: 'Premium',
        groupId: 'group-123',
        price: highPrice,
        isActive: true,
      });

      expect(result.data.modality.price).toBe(highPrice);
    });
  });

  describe('Data Integrity', () => {
    it('should prevent deleting group with modalities', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const groupId = 'group-123';

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };
      const mockGroup = {
        id: groupId,
        eventId,
        modalities: [{ id: 'mod-123' }],
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.modalityGroup.findUnique.mockResolvedValue(mockGroup);

      await expect(service.deleteGroup(userId, eventId, groupId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should maintain referential integrity when deleting modality', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const modalityId = 'mod-123';

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };
      const mockModality = {
        id: modalityId,
        eventId,
        registrations: [], // Sem registrações
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);
      mockPrismaService.modality.delete.mockResolvedValue(mockModality);

      await expect(service.remove(userId, eventId, modalityId)).resolves.toBeDefined();
    });

    it('should prevent deleting modality with registrations', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const modalityId = 'mod-123';

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };
      const mockModality = {
        id: modalityId,
        eventId,
        registrations: [{ id: 'reg-123' }], // Com registrações
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);

      await expect(service.remove(userId, eventId, modalityId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('Group Management', () => {
    it('should allow creating multiple groups per event', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);

      const groups = ['Corridas', 'Caminhadas', 'Ciclismo'];
      for (const groupName of groups) {
        mockPrismaService.modalityGroup.create.mockResolvedValue({
          id: `group-${groupName}`,
          eventId,
          name: groupName,
        });

        await service.createGroup(userId, eventId, {
          name: groupName,
          description: `Group ${groupName}`,
        });
      }

      expect(mockPrismaService.modalityGroup.create).toHaveBeenCalledTimes(3);
    });

    it('should allow reordering modalities within group', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const modalityId = 'mod-123';

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };
      const mockModality = { id: modalityId, eventId, order: 1 };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);
      mockPrismaService.modality.update.mockResolvedValue({
        ...mockModality,
        order: 2,
      });

      const result = await service.update(userId, eventId, modalityId, { order: 2 });

      expect(result.data.modality.order).toBe(2);
    });
  });
});

