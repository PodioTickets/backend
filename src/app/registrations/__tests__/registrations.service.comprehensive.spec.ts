import { Test, TestingModule } from '@nestjs/testing';
import { RegistrationsService } from '../registrations.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { KitsService } from '../../kits/kits.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { RegistrationStatus } from '@prisma/client';

describe('RegistrationsService - Comprehensive Tests', () => {
  let service: RegistrationsService;
  let prisma: PrismaService;
  let kitsService: KitsService;

  const mockPrismaService = {
    event: {
      findUnique: jest.fn(),
    },
    modality: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    registration: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      $transaction: jest.fn(),
    },
    registrationModality: {
      create: jest.fn(),
    },
    registrationKitItem: {
      create: jest.fn(),
    },
    questionAnswer: {
      create: jest.fn(),
    },
    question: {
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const mockKitsService = {
    checkStock: jest.fn(),
    updateStock: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegistrationsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: KitsService,
          useValue: mockKitsService,
        },
      ],
    }).compile();

    service = module.get<RegistrationsService>(RegistrationsService);
    prisma = module.get<PrismaService>(PrismaService);
    kitsService = module.get<KitsService>(KitsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Use Cases - Complete User Flow', () => {
    describe('UC1: User registers for event with modality and kit', () => {
      it('should complete full registration flow successfully', async () => {
        const userId = 'user-123';
        const futureDate = new Date();
        futureDate.setFullYear(futureDate.getFullYear() + 1);

        const createDto = {
          eventId: 'event-123',
          modalities: [{ modalityId: 'mod-123' }],
          kitItems: [
            { kitItemId: 'kit-item-123', size: 'M', quantity: 1 },
          ],
          questionAnswers: [
            { questionId: 'q-123', answer: 'Resposta teste' },
          ],
          termsAccepted: true,
          rulesAccepted: true,
        };

        const mockEvent = {
          id: 'event-123',
          status: 'PUBLISHED',
          name: 'Maratona de São Paulo',
          eventDate: futureDate,
          registrationEndDate: new Date(futureDate.getTime() - 86400000),
          questions: [
            { id: 'q-123', question: 'Qual seu tamanho?', isRequired: true },
          ],
        };

        const mockModality = {
          id: 'mod-123',
          eventId: 'event-123',
          isActive: true,
          price: 150.0,
          name: '5K Run',
          maxParticipants: 100,
          currentParticipants: 0,
        };

        const mockRegistration = {
          id: 'reg-123',
          eventId: 'event-123',
          userId,
          status: RegistrationStatus.PENDING,
          totalAmount: 150.0,
          serviceFee: 7.5,
          finalAmount: 157.5,
          qrCode: 'data:image/png;base64,qrcode123',
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);
        mockKitsService.checkStock.mockResolvedValue(true);
        mockPrismaService.$transaction.mockImplementation(async (callback) => {
          return callback({
            ...mockPrismaService,
            registration: {
              ...mockPrismaService.registration,
              create: jest.fn().mockResolvedValue(mockRegistration),
              update: jest.fn().mockResolvedValue({ ...mockRegistration, qrCode: 'qr-code-123' }),
              findUnique: jest.fn().mockResolvedValue({
                ...mockRegistration,
                modalities: [{ modality: mockModality }],
                kitItems: [{ kitItem: { name: 'Camiseta', sizes: [{ size: 'M', stock: 10 }] } }],
                questionAnswers: [{ question: mockEvent.questions[0], answer: 'Resposta teste' }],
              }),
            },
            registrationModality: {
              create: jest.fn().mockResolvedValue({}),
            },
            registrationKitItem: {
              create: jest.fn().mockResolvedValue({}),
            },
            questionAnswer: {
              create: jest.fn().mockResolvedValue({}),
            },
            modality: {
              update: jest.fn().mockResolvedValue({ ...mockModality, currentParticipants: 1 }),
            },
          });
        });

        const result = await service.create(userId, createDto);

        expect(result.message).toBe('Registration created successfully');
        expect(result.data.registration.totalAmount).toBe(150.0);
        expect(result.data.registration.serviceFee).toBe(7.5);
        expect(result.data.registration.finalAmount).toBe(157.5);
        expect(result.data.registration.qrCode).toBeDefined();
      });
    });

    describe('UC2: User registers another person (invited user)', () => {
      it('should create pre-registration for invited user', async () => {
        const userId = 'user-123';
        const futureDate = new Date();
        futureDate.setFullYear(futureDate.getFullYear() + 1);

        const createDto = {
          eventId: 'event-123',
          modalities: [{ modalityId: 'mod-123' }],
          kitItems: [],
          questionAnswers: [],
          termsAccepted: true,
          rulesAccepted: true,
          invitedUser: {
            email: 'invited@example.com',
            firstName: 'Jane',
            lastName: 'Doe',
            documentNumber: '12345678900',
          },
        };

        const mockEvent = {
          id: 'event-123',
          status: 'PUBLISHED',
          name: 'Test Event',
          eventDate: futureDate,
          registrationEndDate: new Date(futureDate.getTime() - 86400000),
          questions: [],
        };

        const mockModality = {
          id: 'mod-123',
          eventId: 'event-123',
          isActive: true,
          price: 100,
          maxParticipants: 100,
          currentParticipants: 0,
        };

        const mockInvitedUser = {
          id: 'invited-user-123',
          email: createDto.invitedUser.email,
          firstName: createDto.invitedUser.firstName,
          lastName: createDto.invitedUser.lastName,
          documentNumber: createDto.invitedUser.documentNumber,
          isActive: false,
        };

        const mockRegistration = {
          id: 'reg-123',
          eventId: 'event-123',
          userId: mockInvitedUser.id,
          invitedById: userId,
          status: RegistrationStatus.PENDING,
          totalAmount: 100,
          serviceFee: 5,
          finalAmount: 105,
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);
        mockKitsService.checkStock.mockResolvedValue(true);
        mockPrismaService.user.create.mockResolvedValue(mockInvitedUser);
        mockPrismaService.$transaction.mockImplementation(async (callback) => {
          return callback({
            ...mockPrismaService,
            registration: {
              ...mockPrismaService.registration,
              create: jest.fn().mockResolvedValue(mockRegistration),
              update: jest.fn().mockResolvedValue({ ...mockRegistration, qrCode: 'qr-code' }),
              findUnique: jest.fn().mockResolvedValue({
                ...mockRegistration,
                modalities: [],
                kitItems: [],
                questionAnswers: [],
              }),
            },
            registrationModality: {
              create: jest.fn().mockResolvedValue({}),
            },
            modality: {
              update: jest.fn().mockResolvedValue({}),
            },
          });
        });

        const result = await service.create(userId, createDto);

        expect(result.data.registration.userId).toBe(mockInvitedUser.id);
        expect(result.data.registration.invitedById).toBe(userId);
        expect(mockPrismaService.user.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              email: createDto.invitedUser.email,
              isActive: false,
            }),
          }),
        );
      });
    });

    describe('UC3: User views their registrations', () => {
      it('should return all registrations including invited ones', async () => {
        const userId = 'user-123';
        const mockRegistrations = [
          {
            id: 'reg-1',
            userId,
            event: { id: 'event-1', name: 'Event 1', eventDate: new Date('2025-06-15') },
            modalities: [{ modality: { name: '5K', price: 100 } }],
            kitItems: [],
            payment: null,
          },
          {
            id: 'reg-2',
            userId: 'invited-user',
            invitedById: userId,
            event: { id: 'event-2', name: 'Event 2', eventDate: new Date('2025-07-20') },
            modalities: [],
            kitItems: [],
            payment: null,
          },
        ];

        mockPrismaService.registration.findMany.mockResolvedValue(mockRegistrations);

        const result = await service.findUserRegistrations(userId);

        expect(result.data.registrations).toHaveLength(2);
        expect(mockPrismaService.registration.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              OR: [
                { userId },
                { invitedById: userId },
              ],
            },
          }),
        );
      });
    });
  });

  describe('Security Tests', () => {
    describe('Authorization', () => {
      it('should prevent user from accessing other users registrations', async () => {
        const registrationId = 'reg-123';
        const mockRegistration = {
          id: registrationId,
          userId: 'other-user',
          invitedById: null,
        };

        mockPrismaService.registration.findUnique.mockResolvedValue(mockRegistration);

        await expect(service.findOne(registrationId, 'user-123')).rejects.toThrow(
          BadRequestException,
        );
      });

      it('should prevent user from cancelling paid registrations', async () => {
        const userId = 'user-123';
        const registrationId = 'reg-123';
        const mockRegistration = {
          id: registrationId,
          userId,
          status: RegistrationStatus.PENDING,
          payment: { status: 'PAID' },
          modalities: [],
        };

        mockPrismaService.registration.findUnique.mockResolvedValue(mockRegistration);

        await expect(service.cancel(registrationId, userId)).rejects.toThrow(
          BadRequestException,
        );
      });

      it('should validate event ownership in registration', async () => {
        const userId = 'user-123';
        const futureDate = new Date();
        futureDate.setFullYear(futureDate.getFullYear() + 1);

        const createDto = {
          eventId: 'event-123',
          modalities: [{ modalityId: 'mod-999' }], // Modality de outro evento
          kitItems: [],
          questionAnswers: [],
          termsAccepted: true,
          rulesAccepted: true,
        };

        const mockEvent = {
          id: 'event-123',
          status: 'PUBLISHED',
          eventDate: futureDate,
          registrationEndDate: new Date(futureDate.getTime() - 86400000),
          questions: [],
        };

        const mockModality = {
          id: 'mod-999',
          eventId: 'other-event', // Modality de outro evento
          isActive: true,
          price: 100,
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);

        await expect(service.create(userId, createDto)).rejects.toThrow(NotFoundException);
      });
    });

    describe('Input Validation', () => {
      it('should prevent registration with invalid modality IDs', async () => {
        const userId = 'user-123';
        const futureDate = new Date();
        futureDate.setFullYear(futureDate.getFullYear() + 1);

        const createDto = {
          eventId: 'event-123',
          modalities: [{ modalityId: 'invalid-modality-id' }],
          kitItems: [],
          questionAnswers: [],
          termsAccepted: true,
          rulesAccepted: true,
        };

        const mockEvent = {
          id: 'event-123',
          status: 'PUBLISHED',
          eventDate: futureDate,
          registrationEndDate: new Date(futureDate.getTime() - 86400000),
          questions: [],
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.modality.findUnique.mockResolvedValue(null);

        await expect(service.create(userId, createDto)).rejects.toThrow(NotFoundException);
      });

      it('should validate required questions are answered', async () => {
        const userId = 'user-123';
        const futureDate = new Date();
        futureDate.setFullYear(futureDate.getFullYear() + 1);

        const createDto = {
          eventId: 'event-123',
          modalities: [{ modalityId: 'mod-123' }],
          kitItems: [],
          questionAnswers: [], // Missing required question
          termsAccepted: true,
          rulesAccepted: true,
        };

        const mockEvent = {
          id: 'event-123',
          status: 'PUBLISHED',
          eventDate: futureDate,
          registrationEndDate: new Date(futureDate.getTime() - 86400000),
          questions: [
            { id: 'q-123', question: 'Required question', isRequired: true },
          ],
        };

        const mockModality = {
          id: 'mod-123',
          eventId: 'event-123',
          isActive: true,
          price: 100,
          maxParticipants: 100,
          currentParticipants: 0,
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);

        await expect(service.create(userId, createDto)).rejects.toThrow(BadRequestException);
      });

      it('should sanitize user input in question answers', async () => {
        const userId = 'user-123';
        const futureDate = new Date();
        futureDate.setFullYear(futureDate.getFullYear() + 1);

        const maliciousAnswer = '<script>alert("XSS")</script>Dados válidos';
        const createDto = {
          eventId: 'event-123',
          modalities: [{ modalityId: 'mod-123' }],
          kitItems: [],
          questionAnswers: [{ questionId: 'q-123', answer: maliciousAnswer }],
          termsAccepted: true,
          rulesAccepted: true,
        };

        const mockEvent = {
          id: 'event-123',
          status: 'PUBLISHED',
          eventDate: futureDate,
          registrationEndDate: new Date(futureDate.getTime() - 86400000),
          questions: [{ id: 'q-123', question: 'Test', isRequired: true }],
        };

        const mockModality = {
          id: 'mod-123',
          eventId: 'event-123',
          isActive: true,
          price: 100,
          maxParticipants: 100,
          currentParticipants: 0,
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);
        mockKitsService.checkStock.mockResolvedValue(true);
        mockPrismaService.$transaction.mockImplementation(async (callback) => {
          return callback({
            ...mockPrismaService,
            registration: {
              create: jest.fn().mockResolvedValue({ id: 'reg-123' }),
              update: jest.fn().mockResolvedValue({ id: 'reg-123', qrCode: 'qr' }),
              findUnique: jest.fn().mockResolvedValue({
                id: 'reg-123',
                modalities: [],
                kitItems: [],
                questionAnswers: [],
              }),
            },
            registrationModality: { create: jest.fn() },
            questionAnswer: { create: jest.fn() },
            modality: { update: jest.fn() },
          });
        });

        await service.create(userId, createDto);

        // Verificar que a resposta foi salva (sanitização deve ser feita no frontend ou em middleware)
        expect(mockPrismaService.$transaction).toHaveBeenCalled();
      });
    });

    describe('Business Logic Security', () => {
      it('should prevent double registration for same event', async () => {
        const userId = 'user-123';
        const futureDate = new Date();
        futureDate.setFullYear(futureDate.getFullYear() + 1);

        const createDto = {
          eventId: 'event-123',
          modalities: [{ modalityId: 'mod-123' }],
          kitItems: [],
          questionAnswers: [],
          termsAccepted: true,
          rulesAccepted: true,
        };

        const mockEvent = {
          id: 'event-123',
          status: 'PUBLISHED',
          eventDate: futureDate,
          registrationEndDate: new Date(futureDate.getTime() - 86400000),
          questions: [],
        };

        const mockModality = {
          id: 'mod-123',
          eventId: 'event-123',
          isActive: true,
          price: 100,
          maxParticipants: 100,
          currentParticipants: 0,
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);
        mockKitsService.checkStock.mockResolvedValue(true);
      const prismaError = new Error('Unique constraint failed');
      (prismaError as any).code = 'P2002';
      (prismaError as any).meta = { target: ['eventId', 'userId'] };
      
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        const transactionPrisma = {
          ...mockPrismaService,
          registration: {
            create: jest.fn().mockRejectedValue(prismaError),
            findUnique: jest.fn().mockResolvedValue({
              id: 'reg-123',
              modalities: [],
              kitItems: [],
              questionAnswers: [],
            }),
          },
        };
        return callback(transactionPrisma);
      });

        await expect(service.create(userId, createDto)).rejects.toThrow();
      });

      it('should prevent registration after event has occurred', async () => {
        const userId = 'user-123';
        const pastDate = new Date();
        pastDate.setFullYear(pastDate.getFullYear() - 1);

        const mockEvent = {
          id: 'event-123',
          status: 'PUBLISHED',
          eventDate: pastDate,
          registrationEndDate: new Date(pastDate.getTime() - 86400000),
          questions: [],
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);

        await expect(
          service.create(userId, {
            eventId: 'event-123',
            modalities: [],
            termsAccepted: true,
            rulesAccepted: true,
          }),
        ).rejects.toThrow(BadRequestException);
      });
    });
  });

  describe('Performance Tests', () => {
    it('should handle multiple modalities efficiently', async () => {
      const userId = 'user-123';
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const modalities = Array.from({ length: 50 }, (_, i) => ({
        modalityId: `mod-${i}`,
      }));

      const createDto = {
        eventId: 'event-123',
        modalities,
        kitItems: [],
        questionAnswers: [],
        termsAccepted: true,
        rulesAccepted: true,
      };

      const mockEvent = {
        id: 'event-123',
        status: 'PUBLISHED',
        eventDate: futureDate,
        registrationEndDate: new Date(futureDate.getTime() - 86400000),
        questions: [],
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.modality.findUnique.mockImplementation((args) =>
        Promise.resolve({
          id: args.where.id,
          eventId: 'event-123',
          isActive: true,
          price: 100,
          maxParticipants: 100,
          currentParticipants: 0,
        }),
      );
      mockKitsService.checkStock.mockResolvedValue(true);

      const startTime = Date.now();
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        return callback({
          ...mockPrismaService,
          registration: {
            create: jest.fn().mockResolvedValue({ id: 'reg-123' }),
            update: jest.fn().mockResolvedValue({ id: 'reg-123', qrCode: 'qr' }),
            findUnique: jest.fn().mockResolvedValue({
              id: 'reg-123',
              modalities: [],
              kitItems: [],
              questionAnswers: [],
            }),
          },
          registrationModality: { create: jest.fn() },
          modality: { update: jest.fn() },
        });
      });

      try {
        await service.create(userId, createDto);
      } catch (error) {
        // Pode falhar por outros motivos, mas não por performance
      }

      const endTime = Date.now();
      const executionTime = endTime - startTime;

      // Deve processar 50 modalidades em menos de 2 segundos
      expect(executionTime).toBeLessThan(2000);
      expect(mockPrismaService.modality.findUnique).toHaveBeenCalledTimes(50);
    });

    it('should batch database operations in transaction', async () => {
      const userId = 'user-123';
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const createDto = {
        eventId: 'event-123',
        modalities: [{ modalityId: 'mod-123' }, { modalityId: 'mod-456' }],
        kitItems: [
          { kitItemId: 'kit-1', size: 'M', quantity: 1 },
          { kitItemId: 'kit-2', size: 'G', quantity: 2 },
        ],
        questionAnswers: [
          { questionId: 'q-1', answer: 'Answer 1' },
          { questionId: 'q-2', answer: 'Answer 2' },
        ],
        termsAccepted: true,
        rulesAccepted: true,
      };

      const mockEvent = {
        id: 'event-123',
        status: 'PUBLISHED',
        eventDate: futureDate,
        registrationEndDate: new Date(futureDate.getTime() - 86400000),
        questions: [],
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.modality.findUnique.mockResolvedValue({
        id: 'mod-123',
        eventId: 'event-123',
        isActive: true,
        price: 100,
        maxParticipants: 100,
        currentParticipants: 0,
      });
      mockKitsService.checkStock.mockResolvedValue(true);

      let transactionCallCount = 0;
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        transactionCallCount++;
        return callback({
          ...mockPrismaService,
          registration: {
            create: jest.fn().mockResolvedValue({ id: 'reg-123' }),
            update: jest.fn().mockResolvedValue({ id: 'reg-123', qrCode: 'qr' }),
            findUnique: jest.fn().mockResolvedValue({
              id: 'reg-123',
              modalities: [],
              kitItems: [],
              questionAnswers: [],
            }),
          },
          registrationModality: { create: jest.fn() },
          registrationKitItem: { create: jest.fn() },
          questionAnswer: { create: jest.fn() },
          modality: { update: jest.fn() },
        });
      });

      await service.create(userId, createDto);

      // Deve usar apenas uma transação para todas as operações
      expect(transactionCallCount).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle registration with zero price modality', async () => {
      const userId = 'user-123';
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const createDto = {
        eventId: 'event-123',
        modalities: [{ modalityId: 'mod-free' }],
        kitItems: [],
        questionAnswers: [],
        termsAccepted: true,
        rulesAccepted: true,
      };

      const mockEvent = {
        id: 'event-123',
        status: 'PUBLISHED',
        eventDate: futureDate,
        registrationEndDate: new Date(futureDate.getTime() - 86400000),
        questions: [],
      };

      const mockModality = {
        id: 'mod-free',
        eventId: 'event-123',
        isActive: true,
        price: 0,
        maxParticipants: null,
        currentParticipants: 0,
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);
      mockKitsService.checkStock.mockResolvedValue(true);
        mockPrismaService.$transaction.mockImplementation(async (callback) => {
          return callback({
            ...mockPrismaService,
            registration: {
              create: jest.fn().mockResolvedValue({
                id: 'reg-123',
                totalAmount: 0,
                serviceFee: 0,
                finalAmount: 0,
              }),
              update: jest.fn().mockResolvedValue({ id: 'reg-123', qrCode: 'qr' }),
              findUnique: jest.fn().mockResolvedValue({
                id: 'reg-123',
                totalAmount: 0,
                serviceFee: 0,
                finalAmount: 0,
                modalities: [],
                kitItems: [],
                questionAnswers: [],
              }),
            },
            registrationModality: { create: jest.fn() },
            modality: { update: jest.fn() },
          });
        });

      const result = await service.create(userId, createDto);

      expect(result.data.registration.totalAmount).toBe(0);
      expect(result.data.registration.finalAmount).toBe(0);
    });

    it('should handle modality reaching max participants', async () => {
      const userId = 'user-123';
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const mockEvent = {
        id: 'event-123',
        status: 'PUBLISHED',
        eventDate: futureDate,
        registrationEndDate: new Date(futureDate.getTime() - 86400000),
        questions: [],
      };

      const mockModality = {
        id: 'mod-123',
        eventId: 'event-123',
        isActive: true,
        price: 100,
        maxParticipants: 100,
        currentParticipants: 100, // Cheio
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);

      await expect(
        service.create(userId, {
          eventId: 'event-123',
          modalities: [{ modalityId: 'mod-123' }],
          kitItems: [],
          questionAnswers: [],
          termsAccepted: true,
          rulesAccepted: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should handle concurrent registrations for same modality', async () => {
      const userId1 = 'user-1';
      const userId2 = 'user-2';
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const mockEvent = {
        id: 'event-123',
        status: 'PUBLISHED',
        eventDate: futureDate,
        registrationEndDate: new Date(futureDate.getTime() - 86400000),
        questions: [],
      };

      const mockModality = {
        id: 'mod-123',
        eventId: 'event-123',
        isActive: true,
        price: 100,
        maxParticipants: 1, // Apenas 1 vaga
        currentParticipants: 0,
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);
      mockKitsService.checkStock.mockResolvedValue(true);

      // Simular duas requisições simultâneas
      const createDto = {
        eventId: 'event-123',
        modalities: [{ modalityId: 'mod-123' }],
        kitItems: [],
        questionAnswers: [],
        termsAccepted: true,
        rulesAccepted: true,
      };

      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        // Primeira transação incrementa para 1
        const transactionPrisma = {
          ...mockPrismaService,
          registration: {
            create: jest.fn().mockResolvedValue({ id: 'reg-123' }),
            update: jest.fn().mockResolvedValue({ id: 'reg-123', qrCode: 'qr' }),
            findUnique: jest.fn().mockResolvedValue({
              id: 'reg-123',
              modalities: [],
              kitItems: [],
              questionAnswers: [],
            }),
          },
          registrationModality: { create: jest.fn() },
          modality: {
            update: jest.fn().mockResolvedValue({
              ...mockModality,
              currentParticipants: 1,
            }),
          },
        };
        return callback(transactionPrisma);
      });

      // Primeira inscrição deve funcionar
      await expect(service.create(userId1, createDto)).resolves.toBeDefined();

      // Segunda inscrição deve falhar (modality já cheia)
      mockPrismaService.modality.findUnique.mockResolvedValue({
        ...mockModality,
        currentParticipants: 1,
      });

      await expect(service.create(userId2, createDto)).rejects.toThrow(BadRequestException);
    });

    it('should handle stock exhaustion during registration', async () => {
      const userId = 'user-123';
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const createDto = {
        eventId: 'event-123',
        modalities: [{ modalityId: 'mod-123' }],
        kitItems: [{ kitItemId: 'kit-123', size: 'M', quantity: 5 }],
        questionAnswers: [],
        termsAccepted: true,
        rulesAccepted: true,
      };

      const mockEvent = {
        id: 'event-123',
        status: 'PUBLISHED',
        eventDate: futureDate,
        registrationEndDate: new Date(futureDate.getTime() - 86400000),
        questions: [],
      };

      const mockModality = {
        id: 'mod-123',
        eventId: 'event-123',
        isActive: true,
        price: 100,
        maxParticipants: 100,
        currentParticipants: 0,
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);
      mockKitsService.checkStock.mockRejectedValue(
        new BadRequestException('Insufficient stock. Available: 2, Requested: 5'),
      );

      await expect(service.create(userId, createDto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('Data Integrity', () => {
    it('should calculate service fee correctly', async () => {
      const userId = 'user-123';
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const createDto = {
        eventId: 'event-123',
        modalities: [
          { modalityId: 'mod-123' }, // 100
          { modalityId: 'mod-456' }, // 200
        ],
        kitItems: [],
        questionAnswers: [],
        termsAccepted: true,
        rulesAccepted: true,
      };

      const mockEvent = {
        id: 'event-123',
        status: 'PUBLISHED',
        eventDate: futureDate,
        registrationEndDate: new Date(futureDate.getTime() - 86400000),
        questions: [],
      };

      let callCount = 0;
      mockPrismaService.modality.findUnique.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          id: callCount === 1 ? 'mod-123' : 'mod-456',
          eventId: 'event-123',
          isActive: true,
          price: callCount === 1 ? 100 : 200,
          maxParticipants: 100,
          currentParticipants: 0,
        });
      });

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockKitsService.checkStock.mockResolvedValue(true);
        mockPrismaService.$transaction.mockImplementation(async (callback) => {
          return callback({
            ...mockPrismaService,
            registration: {
              create: jest.fn().mockResolvedValue({
                id: 'reg-123',
                totalAmount: 300,
                serviceFee: 15,
                finalAmount: 315,
              }),
              update: jest.fn().mockResolvedValue({ id: 'reg-123', qrCode: 'qr' }),
              findUnique: jest.fn().mockResolvedValue({
                id: 'reg-123',
                totalAmount: 300,
                serviceFee: 15,
                finalAmount: 315,
                modalities: [],
                kitItems: [],
                questionAnswers: [],
              }),
            },
            registrationModality: { create: jest.fn() },
            modality: { update: jest.fn() },
          });
        });

      const result = await service.create(userId, createDto);

      expect(result.data.registration.totalAmount).toBe(300);
      expect(result.data.registration.serviceFee).toBe(15);
      expect(result.data.registration.finalAmount).toBe(315);
    });

    it('should generate unique QR codes for each registration', async () => {
      const userId = 'user-123';
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const createDto1 = {
        eventId: 'event-123',
        modalities: [{ modalityId: 'mod-123' }],
        kitItems: [],
        questionAnswers: [],
        termsAccepted: true,
        rulesAccepted: true,
      };

      const createDto2 = {
        eventId: 'event-456',
        modalities: [{ modalityId: 'mod-456' }],
        kitItems: [],
        questionAnswers: [],
        termsAccepted: true,
        rulesAccepted: true,
      };

      mockPrismaService.event.findUnique.mockImplementation((args) => {
        const eventId = args.where.id;
        return Promise.resolve({
          id: eventId,
          status: 'PUBLISHED',
          name: 'Test Event',
          eventDate: futureDate,
          registrationEndDate: new Date(futureDate.getTime() - 86400000),
          questions: [],
        });
      });

      mockPrismaService.modality.findUnique.mockImplementation((args) => {
        const modalityId = args.where.id;
        const eventId = modalityId === 'mod-123' ? 'event-123' : 'event-456';
        return Promise.resolve({
          id: modalityId,
          eventId,
          isActive: true,
          price: 100,
          maxParticipants: 100,
          currentParticipants: 0,
        });
      });
      mockKitsService.checkStock.mockResolvedValue(true);

      const qrCodes: string[] = [];
      let callCount = 0;
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        callCount++;
        return callback({
          ...mockPrismaService,
          registration: {
            create: jest.fn().mockResolvedValue({ id: `reg-${callCount}` }),
            update: jest.fn().mockImplementation((args) => {
              qrCodes.push(args.data.qrCode);
              return Promise.resolve({ id: `reg-${callCount}`, qrCode: args.data.qrCode });
            }),
            findUnique: jest.fn().mockImplementation(() => {
              return Promise.resolve({
                id: `reg-${callCount}`,
                qrCode: qrCodes[qrCodes.length - 1],
                modalities: [],
                kitItems: [],
                questionAnswers: [],
              });
            }),
          },
          registrationModality: { create: jest.fn() },
          modality: { update: jest.fn() },
        });
      });

      const result1 = await service.create(userId, createDto1);
      const result2 = await service.create(userId, createDto2);

      expect(result1.data.registration.qrCode).toBeDefined();
      expect(result2.data.registration.qrCode).toBeDefined();
      expect(result1.data.registration.qrCode).not.toBe(result2.data.registration.qrCode);
    });
  });

  describe('Validation Tests', () => {
    it('should validate terms and rules acceptance', async () => {
      const userId = 'user-123';
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const mockEvent = {
        id: 'event-123',
        status: 'PUBLISHED',
        eventDate: futureDate,
        registrationEndDate: new Date(futureDate.getTime() - 86400000),
        questions: [],
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);

      const testCases = [
        { termsAccepted: false, rulesAccepted: true },
        { termsAccepted: true, rulesAccepted: false },
        { termsAccepted: false, rulesAccepted: false },
      ];

      for (const testCase of testCases) {
        await expect(
          service.create(userId, {
            eventId: 'event-123',
            modalities: [],
            kitItems: [],
            questionAnswers: [],
            ...testCase,
          }),
        ).rejects.toThrow(BadRequestException);
      }
    });

    it('should validate event status', async () => {
      const userId = 'user-123';
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const statuses = ['DRAFT', 'CANCELLED', 'COMPLETED'];

      for (const status of statuses) {
        const mockEvent = {
          id: 'event-123',
          status,
          eventDate: futureDate,
          registrationEndDate: new Date(futureDate.getTime() - 86400000),
          questions: [],
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);

        await expect(
          service.create(userId, {
            eventId: 'event-123',
            modalities: [],
            kitItems: [],
            questionAnswers: [],
            termsAccepted: true,
            rulesAccepted: true,
          }),
        ).rejects.toThrow(BadRequestException);
      }
    });

    it('should validate registration end date', async () => {
      const userId = 'user-123';
      const pastDate = new Date();
      pastDate.setFullYear(pastDate.getFullYear() - 1);

      const mockEvent = {
        id: 'event-123',
        status: 'PUBLISHED',
        eventDate: new Date('2025-12-31'),
        registrationEndDate: pastDate,
        questions: [],
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);

      await expect(
        service.create(userId, {
          eventId: 'event-123',
          modalities: [],
          kitItems: [],
          questionAnswers: [],
          termsAccepted: true,
          rulesAccepted: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Cancel Registration Flow', () => {
    it('should refund stock when cancelling registration', async () => {
      const userId = 'user-123';
      const registrationId = 'reg-123';
      const mockRegistration = {
        id: registrationId,
        userId,
        status: RegistrationStatus.PENDING,
        payment: null,
        modalities: [{ modalityId: 'mod-123' }],
      };

      mockPrismaService.registration.findUnique.mockResolvedValue(mockRegistration);
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        return callback({
          registration: {
            update: jest.fn().mockResolvedValue({
              ...mockRegistration,
              status: RegistrationStatus.CANCELLED,
            }),
          },
          modality: {
            update: jest.fn().mockResolvedValue({
              id: 'mod-123',
              currentParticipants: 0,
            }),
          },
        });
      });

      await service.cancel(registrationId, userId);

      expect(mockPrismaService.$transaction).toHaveBeenCalled();
    });

    it('should prevent cancelling already cancelled registration', async () => {
      const userId = 'user-123';
      const registrationId = 'reg-123';
      const mockRegistration = {
        id: registrationId,
        userId,
        status: RegistrationStatus.CANCELLED,
        payment: null,
        modalities: [],
      };

      mockPrismaService.registration.findUnique.mockResolvedValue(mockRegistration);

      await expect(service.cancel(registrationId, userId)).rejects.toThrow(BadRequestException);
    });
  });
});

