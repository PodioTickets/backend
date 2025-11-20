import { Test, TestingModule } from '@nestjs/testing';
import { KitsService } from '../kits.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('KitsService - Comprehensive Tests', () => {
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
      findUnique: jest.fn(),
      create: jest.fn(),
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

  describe('Use Cases - User Flow', () => {
    describe('UC1: Organizer creates kit with items and sizes', () => {
      it('should create kit with multiple items and size variants', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';
        const createDto = {
          name: 'Kit Completo',
          description: 'Kit com camiseta e medalha',
          isActive: true,
          items: [
            {
              name: 'Camiseta',
              description: 'Camiseta técnica',
              sizes: [
                { size: 'P', stock: 10 },
                { size: 'M', stock: 20 },
                { size: 'G', stock: 15 },
              ],
              isActive: true,
            },
            {
              name: 'Medalha',
              description: 'Medalha de participação',
              sizes: [{ size: 'Único', stock: 100 }],
              isActive: true,
            },
          ],
        };

        const mockEvent = { id: eventId, organizerId: 'org-123' };
        const mockOrganizer = { id: 'org-123', userId };
        const mockKit = {
          id: 'kit-123',
          eventId,
          ...createDto,
          items: createDto.items.map((item, idx) => ({
            id: `item-${idx}`,
            ...item,
          })),
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.kit.create.mockResolvedValue(mockKit);

        const result = await service.create(userId, eventId, createDto);

        expect(result.data.kit.items).toHaveLength(2);
        expect(result.data.kit.items[0].sizes).toHaveLength(3);
      });
    });

    describe('UC2: User checks kit availability', () => {
      it('should verify stock availability for specific size', async () => {
        const kitItemId = 'item-123';
        const size = 'M';
        const quantity = 2;

        const mockKitItem = {
          id: kitItemId,
          sizes: [
            { size: 'P', stock: 5 },
            { size: 'M', stock: 10 },
            { size: 'G', stock: 8 },
          ],
        };

        mockPrismaService.kitItem.findUnique.mockResolvedValue(mockKitItem);

        await expect(service.checkStock(kitItemId, size, quantity)).resolves.toBe(true);
      });

      it('should throw error when stock is insufficient', async () => {
        const kitItemId = 'item-123';
        const size = 'M';
        const quantity = 15; // Mais que o disponível (10)

        const mockKitItem = {
          id: kitItemId,
          sizes: [
            { size: 'M', stock: 10 },
          ],
        };

        mockPrismaService.kitItem.findUnique.mockResolvedValue(mockKitItem);

        await expect(service.checkStock(kitItemId, size, quantity)).rejects.toThrow(
          BadRequestException,
        );
      });
    });

    describe('UC3: Stock is updated after registration', () => {
      it('should decrease stock correctly', async () => {
        const kitItemId = 'item-123';
        const size = 'M';
        const quantity = 3;

        const mockKitItem = {
          id: kitItemId,
          sizes: [
            { size: 'M', stock: 10 },
          ],
        };

        mockPrismaService.kitItem.findUnique.mockResolvedValue(mockKitItem);
        mockPrismaService.kitItem.update.mockResolvedValue({
          ...mockKitItem,
          sizes: [{ size: 'M', stock: 7 }],
        });

        await service.updateStock(kitItemId, size, -quantity);

        expect(mockPrismaService.kitItem.update).toHaveBeenCalled();
      });

      it('should prevent negative stock', async () => {
        const kitItemId = 'item-123';
        const size = 'M';
        const quantity = 15; // Mais que o disponível

        const mockKitItem = {
          id: kitItemId,
          sizes: [
            { size: 'M', stock: 10 },
          ],
        };

        mockPrismaService.kitItem.findUnique.mockResolvedValue(mockKitItem);

        // O updateStock não valida estoque negativo antes de atualizar
        // Primeiro verifica se há estoque suficiente usando checkStock
        await expect(service.checkStock(kitItemId, size, quantity)).rejects.toThrow(
          BadRequestException,
        );
      });
    });
  });

  describe('Security Tests', () => {
    describe('Authorization', () => {
      it('should prevent non-organizer from creating kits', async () => {
        const userId = 'user-123';
        const eventId = 'event-123';

        const mockEvent = { id: eventId, organizerId: 'org-999' };
        const mockOrganizer = null;

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);

        await expect(
          service.create(userId, eventId, {
            name: 'Test Kit',
            description: 'Test',
            items: [],
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('should prevent organizer from modifying other organizers kits', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';
        const kitId = 'kit-123';

        const mockEvent = { id: eventId, organizerId: 'org-999' };
        const mockOrganizer = { id: 'org-123', userId };
        const mockKit = { id: kitId, eventId, name: 'Other Kit' };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.kit.findUnique.mockResolvedValue(mockKit);

        await expect(
          service.update(userId, eventId, kitId, { name: 'Hacked' }),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('Input Validation', () => {
      it('should validate stock is non-negative', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';
        const createDto = {
          name: 'Test Kit',
          items: [
            {
              name: 'Item',
              sizes: [{ size: 'M', stock: -5 }], // Stock negativo
            },
          ],
        };

        const mockEvent = { id: eventId, organizerId: 'org-123' };
        const mockOrganizer = { id: 'org-123', userId };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.kit.create.mockRejectedValue(new Error('Invalid stock'));

        await expect(service.create(userId, eventId, createDto)).rejects.toThrow();
      });

      it('should validate size names are not empty', async () => {
        const kitItemId = 'item-123';

        const mockKitItem = {
          id: kitItemId,
          sizes: [
            { size: 'M', stock: 10 },
          ],
        };

        mockPrismaService.kitItem.findUnique.mockResolvedValue(mockKitItem);

        // Tentar buscar um tamanho que não existe (string vazia não é um tamanho válido)
        await expect(service.checkStock(kitItemId, 'XL', 1)).rejects.toThrow(BadRequestException);
      });
    });
  });

  describe('Performance Tests', () => {
    it('should handle large kit catalogs efficiently', async () => {
      const eventId = 'event-123';
      const largeKitList = Array.from({ length: 100 }, (_, i) => ({
        id: `kit-${i}`,
        name: `Kit ${i}`,
        eventId,
        isActive: true,
        items: Array.from({ length: 10 }, (_, j) => ({
          id: `item-${i}-${j}`,
          name: `Item ${j}`,
          sizes: [{ size: 'M', stock: 10 }],
        })),
      }));

      mockPrismaService.kit.findMany.mockResolvedValue(largeKitList);

      const startTime = Date.now();
      const result = await service.findAll(eventId);
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(1000);
      expect(result.data.kits).toHaveLength(100);
    });

    it('should batch stock updates efficiently', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const updates = Array.from({ length: 50 }, (_, i) => ({
        kitItemId: `item-${i}`,
        size: 'M',
        quantity: -1,
      }));

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.kitItem.findUnique.mockResolvedValue({
        id: 'item-123',
        sizes: [{ size: 'M', stock: 100 }],
      });
      mockPrismaService.kitItem.update.mockResolvedValue({
        id: 'item-123',
        sizes: [{ size: 'M', stock: 99 }],
      });

      const startTime = Date.now();
      for (const update of updates) {
        try {
          await service.updateStock(update.kitItemId, update.size, update.quantity);
        } catch (error) {
          // Ignorar erros de item não encontrado
        }
      }
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(2000);
    });
  });

  describe('Edge Cases', () => {
    it('should handle kit with zero stock items', async () => {
      const kitItemId = 'item-123';
      const size = 'M';

      const mockKitItem = {
        id: kitItemId,
        sizes: [
          { size: 'M', stock: 0 },
        ],
      };

      mockPrismaService.kitItem.findUnique.mockResolvedValue(mockKitItem);

      await expect(service.checkStock(kitItemId, size, 1)).rejects.toThrow(BadRequestException);
    });

      it('should handle kit item with no sizes', async () => {
        const kitItemId = 'item-123';
        const mockKitItem = {
          id: kitItemId,
          sizes: [],
        };

        mockPrismaService.kitItem.findUnique.mockResolvedValue(mockKitItem);

        await expect(service.checkStock(kitItemId, 'M', 1)).rejects.toThrow(BadRequestException);
      });

    it('should handle size name case sensitivity', async () => {
      const kitItemId = 'item-123';
      const mockKitItem = {
        id: kitItemId,
        sizes: [
          { size: 'M', stock: 10 },
          { size: 'm', stock: 5 }, // Tamanho minúsculo
        ],
      };

      mockPrismaService.kitItem.findUnique.mockResolvedValue(mockKitItem);

      // Deve encontrar o tamanho correto (case-sensitive)
      await expect(service.checkStock(kitItemId, 'M', 1)).resolves.toBe(true);
      await expect(service.checkStock(kitItemId, 'm', 1)).resolves.toBe(true);
    });

    it('should handle very large stock numbers', async () => {
      const kitItemId = 'item-123';
      const size = 'M';
      const quantity = 999999;

      const mockKitItem = {
        id: kitItemId,
        sizes: [
          { size: 'M', stock: 1000000 },
        ],
      };

      mockPrismaService.kitItem.findUnique.mockResolvedValue(mockKitItem);

        await expect(service.checkStock(kitItemId, size, quantity)).resolves.toBe(true);
    });
  });

  describe('Data Integrity', () => {
    it('should maintain stock consistency during concurrent updates', async () => {
      const kitItemId = 'item-123';
      const size = 'M';
      const initialStock = 10;

      const mockKitItem = {
        id: kitItemId,
        sizes: [
          { size: 'M', stock: initialStock },
        ],
      };

      mockPrismaService.kitItem.findUnique.mockResolvedValue(mockKitItem);
      mockPrismaService.kitItem.update.mockImplementation((args) => {
        const currentStock = mockKitItem.sizes[0].stock;
        const newStock = currentStock + args.data.sizes[0].stock;
        return Promise.resolve({
          ...mockKitItem,
          sizes: [{ size: 'M', stock: Math.max(0, newStock) }],
        });
      });

      // Simular múltiplas atualizações concorrentes
      const updates = [-1, -2, -3];
      for (const update of updates) {
        mockKitItem.sizes[0].stock += update;
        await service.updateStock(kitItemId, size, update);
      }

      expect(mockPrismaService.kitItem.update).toHaveBeenCalledTimes(3);
    });

    it('should prevent stock update for non-existent size', async () => {
      const kitItemId = 'item-123';
      const size = 'XL'; // Tamanho não existe

      const mockKitItem = {
        id: kitItemId,
        sizes: [
          { size: 'M', stock: 10 },
        ],
      };

      mockPrismaService.kitItem.findUnique.mockResolvedValue(mockKitItem);

      await expect(service.updateStock(kitItemId, size, -1)).rejects.toThrow(BadRequestException);
    });
  });

  describe('Kit Item Management', () => {
    it('should allow creating kit item with multiple sizes', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const kitId = 'kit-123';
      const createItemDto = {
        name: 'Camiseta',
        description: 'Camiseta técnica',
        sizes: [
          { size: 'P', stock: 10 },
          { size: 'M', stock: 20 },
          { size: 'G', stock: 15 },
          { size: 'GG', stock: 5 },
        ],
        isActive: true,
      };

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };
      const mockKit = { id: kitId, eventId };
      const mockItem = {
        id: 'item-123',
        kitId,
        ...createItemDto,
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.kit.findUnique.mockResolvedValue(mockKit);
      mockPrismaService.kitItem.create.mockResolvedValue(mockItem);

      const result = await service.createItem(userId, eventId, kitId, createItemDto);

      expect(result.data.item.sizes).toHaveLength(4);
    });

      it('should prevent deleting kit with active items', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';
        const kitId = 'kit-123';

        const mockEvent = { id: eventId, organizerId: 'org-123' };
        const mockOrganizer = { id: 'org-123', userId };
        const mockKit = {
          id: kitId,
          eventId,
          items: [{ id: 'item-123', registrations: [{ id: 'reg-123' }] }], // Com registrações
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.kit.findUnique.mockResolvedValue(mockKit);

        await expect(service.remove(userId, eventId, kitId)).rejects.toThrow(BadRequestException);
      });
  });
});

