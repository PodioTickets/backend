import { Test, TestingModule } from '@nestjs/testing';
import { RegistrationsService } from '../registrations.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { KitsService } from '../../kits/kits.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { RegistrationStatus } from '@prisma/client';

describe('RegistrationsService', () => {
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

  describe('create', () => {
    it('should create a registration successfully', async () => {
      const userId = 'user-123';
      const createDto = {
        eventId: 'event-123',
        modalities: [{ modalityId: 'mod-123' }],
        kitItems: [],
        questionAnswers: [],
        termsAccepted: true,
        rulesAccepted: true,
      };

      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const mockEvent = {
        id: 'event-123',
        status: 'PUBLISHED',
        eventDate: futureDate,
        registrationEndDate: new Date(futureDate.getTime() - 86400000), // 1 day before event
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

      const mockRegistration = {
        id: 'reg-123',
        eventId: 'event-123',
        userId,
        status: RegistrationStatus.PENDING,
        totalAmount: 100,
        serviceFee: 5,
        finalAmount: 105,
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.modality.findUnique.mockResolvedValue(mockModality);
      mockKitsService.checkStock.mockResolvedValue(true);
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        return callback({
          ...mockPrismaService,
          registration: {
            ...mockPrismaService.registration,
            create: jest.fn().mockResolvedValue({
              ...mockRegistration,
              qrCode: 'qr-code-123',
            }),
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
          registrationKitItem: {
            create: jest.fn().mockResolvedValue({}),
          },
          questionAnswer: {
            create: jest.fn().mockResolvedValue({}),
          },
          modality: {
            update: jest.fn().mockResolvedValue({}),
          },
        });
      });

      const result = await service.create(userId, createDto);

      expect(result.message).toBe('Registration created successfully');
      expect(result.data.registration).toBeDefined();
    });

    it('should throw NotFoundException if event not found', async () => {
      mockPrismaService.event.findUnique.mockResolvedValue(null);

      await expect(
        service.create('user-123', {
          eventId: 'invalid-id',
          modalities: [],
          termsAccepted: true,
          rulesAccepted: true,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if registration period has ended', async () => {
      const mockEvent = {
        id: 'event-123',
        status: 'PUBLISHED',
        eventDate: new Date('2024-12-31'),
        registrationEndDate: new Date('2020-01-01'),
        questions: [],
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);

      await expect(
        service.create('user-123', {
          eventId: 'event-123',
          modalities: [],
          termsAccepted: true,
          rulesAccepted: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if terms not accepted', async () => {
      const mockEvent = {
        id: 'event-123',
        status: 'PUBLISHED',
        eventDate: new Date('2024-12-31'),
        registrationEndDate: new Date('2024-12-30'),
        questions: [],
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);

      await expect(
        service.create('user-123', {
          eventId: 'event-123',
          modalities: [],
          termsAccepted: false,
          rulesAccepted: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findUserRegistrations', () => {
    it('should return user registrations', async () => {
      const userId = 'user-123';
      const mockRegistrations = [
        {
          id: 'reg-123',
          userId,
          event: { name: 'Test Event' },
          modalities: [],
          kitItems: [],
        },
      ];

      mockPrismaService.registration.findMany.mockResolvedValue(mockRegistrations);

      const result = await service.findUserRegistrations(userId);

      expect(result.message).toBe('Registrations fetched successfully');
      expect(result.data.registrations).toEqual(mockRegistrations);
    });
  });

  describe('findOne', () => {
    it('should return a registration by id', async () => {
      const userId = 'user-123';
      const registrationId = 'reg-123';
      const mockRegistration = {
        id: registrationId,
        userId,
        event: { name: 'Test Event' },
        modalities: [],
        kitItems: [],
      };

      mockPrismaService.registration.findUnique.mockResolvedValue(mockRegistration);

      const result = await service.findOne(registrationId, userId);

      expect(result.message).toBe('Registration fetched successfully');
      expect(result.data.registration).toEqual(mockRegistration);
    });

    it('should throw NotFoundException if registration not found', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue(null);

      await expect(service.findOne('invalid-id', 'user-123')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException if access denied', async () => {
      const mockRegistration = {
        id: 'reg-123',
        userId: 'other-user',
        invitedById: null,
      };

      mockPrismaService.registration.findUnique.mockResolvedValue(mockRegistration);

      await expect(service.findOne('reg-123', 'user-123')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('cancel', () => {
    it('should cancel a registration successfully', async () => {
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
            update: jest.fn().mockResolvedValue({}),
          },
        });
      });

      const result = await service.cancel(registrationId, userId);

      expect(result.message).toBe('Registration cancelled successfully');
    });

    it('should throw BadRequestException if payment already paid', async () => {
      const mockRegistration = {
        id: 'reg-123',
        userId: 'user-123',
        status: RegistrationStatus.PENDING,
        payment: { status: 'PAID' },
        modalities: [],
      };

      mockPrismaService.registration.findUnique.mockResolvedValue(mockRegistration);

      await expect(service.cancel('reg-123', 'user-123')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});

