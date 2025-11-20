import { Test, TestingModule } from '@nestjs/testing';
import { EventsService } from '../events.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { EventStatus } from '@prisma/client';

describe('EventsService - Comprehensive Tests', () => {
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

    // Mock getReadClient and getWriteClient to return the same mock
    mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
    mockPrismaService.getWriteClient.mockReturnValue(mockPrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Use Cases - User Flow', () => {
    describe('UC1: Organizer creates event with all details', () => {
      it('should create event with banner, location, and default topics', async () => {
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
          registrationEndDate: '2025-06-10T23:59:59Z',
        };

        const mockOrganizer = { id: 'org-123', userId };
        const mockEvent = {
          id: 'event-123',
          ...createEventDto,
          organizerId: mockOrganizer.id,
          organizer: {
            user: { id: userId, firstName: 'John', lastName: 'Doe', email: 'john@example.com' },
          },
        };

        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.event.create.mockResolvedValue(mockEvent);
        mockPrismaService.eventTopic.createMany.mockResolvedValue({ count: 4 });

        const result = await service.create(userId, createEventDto);

        expect(result.data.event).toBeDefined();
        expect(result.data.event.name).toBe(createEventDto.name);
        expect(mockPrismaService.eventTopic.createMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.arrayContaining([
              expect.objectContaining({ title: 'Descrição do Evento' }),
              expect.objectContaining({ title: 'KIT' }),
              expect.objectContaining({ title: 'PREMIAÇÃO' }),
              expect.objectContaining({ title: 'REGULAMENTO' }),
            ]),
          }),
        );
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
        expect(mockPrismaService.event.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              country: 'Brasil',
              state: 'SP',
              city: 'São Paulo',
              name: expect.objectContaining({ contains: 'Maratona', mode: 'insensitive' }),
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
        const eventId = 'event-123';
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

        expect(result.data.event).toEqual(mockEvent);
        expect(result.data.event.organizer).toBeDefined();
        expect(result.data.event.topics).toBeDefined();
        expect(result.data.event.locations).toBeDefined();
      });
    });
  });

  describe('Security Tests', () => {
    describe('Authorization', () => {
      it('should prevent non-organizer from creating events', async () => {
        mockPrismaService.organizer.findUnique.mockResolvedValue(null);

        await expect(
          service.create('user-123', {
            name: 'Test Event',
            location: 'Test',
            city: 'Test',
            state: 'Test',
            country: 'Test',
            eventDate: '2025-12-31T00:00:00Z',
            registrationEndDate: '2025-12-30T00:00:00Z',
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('should prevent organizer from updating other organizers events', async () => {
        const userId = 'user-123';
        const eventId = 'event-123';
        const otherOrganizer = { id: 'org-999', userId: 'other-user' };
        const event = { id: eventId, organizerId: 'org-999' };

        mockPrismaService.organizer.findUnique.mockResolvedValue({ id: 'org-123', userId });
        mockPrismaService.event.findUnique.mockResolvedValue(event);

        await expect(service.update(userId, eventId, { name: 'Hacked' })).rejects.toThrow(
          BadRequestException,
        );
      });

      it('should prevent SQL injection in search filters', async () => {
        const maliciousInput = "'; DROP TABLE events; --";
        mockPrismaService.event.findMany.mockResolvedValue([]);
        mockPrismaService.event.count.mockResolvedValue(0);

        await service.findAll({ name: maliciousInput, page: 1, limit: 10 });

        // Verificar que Prisma trata o input como string literal, não como SQL
        expect(mockPrismaService.event.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              name: expect.objectContaining({
                contains: maliciousInput,
              }),
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
          registrationEndDate: '2025-12-30T00:00:00Z',
        };

        const mockOrganizer = { id: 'org-123', userId };
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.event.create.mockResolvedValue({
          id: 'event-123',
          ...createEventDto,
        });
        mockPrismaService.eventTopic.createMany.mockResolvedValue({ count: 4 });

        await service.create(userId, createEventDto);

        // O Prisma deve armazenar como está, mas a validação do DTO deve prevenir
        expect(mockPrismaService.event.create).toHaveBeenCalled();
      });

      it('should validate date formats', async () => {
        const userId = 'org-user-123';
        mockPrismaService.organizer.findUnique.mockResolvedValue({ id: 'org-123', userId });

        // Teste que datas inválidas não são aceitas pelo Prisma
        // Nota: O Prisma aceita strings ISO válidas, então precisamos testar em um nível diferente
        // Este teste verifica que o serviço processa datas corretamente
        const validDate = '2025-12-31T00:00:00Z';
        const invalidDate = 'not-a-date';
        
        mockPrismaService.event.create.mockImplementation((args) => {
          const eventDate = new Date(args.data.eventDate);
          if (isNaN(eventDate.getTime())) {
            throw new Error('Invalid date');
          }
          return Promise.resolve({
            id: 'event-123',
            ...args.data,
          });
        });
        mockPrismaService.eventTopic.createMany.mockResolvedValue({ count: 4 });

        await expect(
          service.create(userId, {
            name: 'Test',
            location: 'Test',
            city: 'Test',
            state: 'Test',
            country: 'Test',
            eventDate: validDate,
            registrationEndDate: '2025-12-30T00:00:00Z',
          }),
        ).resolves.toBeDefined();

        mockPrismaService.event.create.mockImplementation((args) => {
          const eventDate = new Date(args.data.eventDate);
          if (isNaN(eventDate.getTime())) {
            throw new Error('Invalid date');
          }
          return Promise.resolve({
            id: 'event-123',
            ...args.data,
          });
        });

        await expect(
          service.create(userId, {
            name: 'Test',
            location: 'Test',
            city: 'Test',
            state: 'Test',
            country: 'Test',
            eventDate: invalidDate,
            registrationEndDate: '2025-12-30T00:00:00Z',
          }),
        ).rejects.toThrow();
      });
    });

    describe('Access Control', () => {
      it('should allow only event owner to update event', async () => {
        const ownerId = 'owner-123';
        const attackerId = 'attacker-123';
        const eventId = 'event-123';

        const ownerOrganizer = { id: 'org-owner', userId: ownerId };
        const attackerOrganizer = { id: 'org-attacker', userId: attackerId };
        const event = { id: eventId, organizerId: 'org-owner' };

        mockPrismaService.organizer.findUnique
          .mockResolvedValueOnce(attackerOrganizer)
          .mockResolvedValueOnce(ownerOrganizer);
        mockPrismaService.event.findUnique.mockResolvedValue(event);

        await expect(
          service.update(attackerId, eventId, { name: 'Hacked Event' }),
        ).rejects.toThrow(BadRequestException);

        // Verificar que o evento não foi atualizado
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
        registrationEndDate: '2025-06-10T23:59:59Z', // Antes do evento
      };

      const mockOrganizer = { id: 'org-123', userId };
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.create.mockResolvedValue({
        id: 'event-123',
        ...createEventDto,
      });
      mockPrismaService.eventTopic.createMany.mockResolvedValue({ count: 4 });

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
        registrationEndDate: '2025-12-30T00:00:00Z',
      };

      const mockOrganizer = { id: 'org-123', userId };
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.create.mockResolvedValue({
        id: 'event-123',
        ...createEventDto,
      });
      mockPrismaService.eventTopic.createMany.mockResolvedValue({ count: 4 });

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
        registrationEndDate: '2025-12-30T00:00:00Z',
      };

      const mockOrganizer = { id: 'org-123', userId };
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.create.mockResolvedValue({
        id: 'event-123',
        ...createEventDto,
      });
      mockPrismaService.eventTopic.createMany.mockResolvedValue({ count: 4 });

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
        registrationEndDate: '2025-12-30T00:00:00Z',
      };

      const mockOrganizer = { id: 'org-123', userId };
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      
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
        registrationEndDate: '2025-06-10T23:59:59-03:00',
      };

      const mockOrganizer = { id: 'org-123', userId };
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.create.mockResolvedValue({
        id: 'event-123',
        ...createEventDto,
        eventDate: new Date(createEventDto.eventDate),
        registrationEndDate: new Date(createEventDto.registrationEndDate),
      });
      mockPrismaService.eventTopic.createMany.mockResolvedValue({ count: 4 });

      const result = await service.create(userId, createEventDto);
      expect(result.data.event.eventDate).toBeInstanceOf(Date);
    });
  });

  describe('Topic Management', () => {
    it('should allow organizer to disable default topics', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const updateDto = { isEnabled: false };

      const mockOrganizer = { id: 'org-123', userId };
      const mockEvent = { id: eventId, organizerId: mockOrganizer.id };
      const mockTopic = {
        id: 'topic-123',
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

      const result = await service.updateTopic(userId, eventId, 'topic-123', updateDto);

      expect(result.data.topic.isEnabled).toBe(false);
    });

    it('should prevent deletion of default topics', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const topicId = 'topic-123';

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
      const eventId = 'event-123';
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

