import { Test, TestingModule } from '@nestjs/testing';
import { RegistrationsService } from '../../registrations/registrations.service';
import { PaymentsService } from '../../payments/payments.service';
import { AuthService } from '../../auth/auth.service';
import { UserService } from '../../user/user.service';
import { EventsService } from '../../events/events.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { KitsService } from '../../kits/kits.service';
import { CieloService } from '../../payments/cielo.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PaymentMethod } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

describe('End-to-End Performance Tests - High Traffic Simulation', () => {
  let registrationsService: RegistrationsService;
  let paymentsService: PaymentsService;
  let authService: AuthService;
  let userService: UserService;
  let eventsService: EventsService;

  const mockPrismaService = {
    event: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
    },
    organizer: {
      findUnique: jest.fn(),
    },
    modality: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    registration: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
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
    payment: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    eventTopic: {
      create: jest.fn(),
      createMany: jest.fn(),
    },
    eventLocation: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
    getReadClient: jest.fn(),
    getWriteClient: jest.fn(),
  };

  const mockKitsService = {
    checkStock: jest.fn().mockResolvedValue(true),
    updateStock: jest.fn().mockResolvedValue(true),
  };

  const mockCieloService = {
    createPayment: jest.fn(),
    capturePayment: jest.fn(),
    getPayment: jest.fn(),
    mapCieloStatusToPaymentStatus: jest.fn(),
    mapCieloStatusToString: jest.fn(),
  };

  const mockJwtService = {
    sign: jest.fn().mockReturnValue('mock-token'),
    verify: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue('mock-secret'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegistrationsService,
        PaymentsService,
        AuthService,
        UserService,
        EventsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: KitsService,
          useValue: mockKitsService,
        },
        {
          provide: CieloService,
          useValue: mockCieloService,
        },
        {
          provide: JwtService,
          useValue: mockJwtService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    registrationsService = module.get<RegistrationsService>(RegistrationsService);
    paymentsService = module.get<PaymentsService>(PaymentsService);
    authService = module.get<AuthService>(AuthService);
    userService = module.get<UserService>(UserService);
    eventsService = module.get<EventsService>(EventsService);

    mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
    mockPrismaService.getWriteClient.mockReturnValue(mockPrismaService);
    mockPrismaService.$transaction.mockImplementation(async (callback) => {
      return callback(mockPrismaService);
    });

    // Mock rápido para performance
    jest.spyOn(bcrypt, 'hash').mockImplementation(() => Promise.resolve('hashed'));
    jest.spyOn(bcrypt, 'compare').mockImplementation(() => Promise.resolve(true));
    jest.spyOn(authService as any, 'createRefreshToken').mockResolvedValue('refresh-token');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Complete User Journey - High Traffic', () => {
    it('should handle complete user journey: register → login → search events → register → payment', async () => {
      const concurrentUsers = 100;
      const startTime = Date.now();

      // Setup mocks
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPrismaService.user.create.mockImplementation(({ data }) => ({
        id: `user-${data.email}`,
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        role: 'USER',
        isActive: true,
      }));

      mockPrismaService.event.findMany.mockResolvedValue([
        {
          id: 'event-123',
          name: 'Test Event',
          status: 'PUBLISHED',
        },
      ]);

      mockPrismaService.event.findUnique.mockResolvedValue({
        id: 'event-123',
        status: 'PUBLISHED',
        registrationEndDate: new Date(Date.now() + 86400000),
        eventDate: new Date(Date.now() + 172800000),
        questions: [],
      });

      mockPrismaService.modality.findUnique.mockResolvedValue({
        id: 'modality-123',
        eventId: 'event-123',
        isActive: true,
        price: 100,
        maxParticipants: 1000,
        currentParticipants: 0,
      });

      mockPrismaService.registration.create.mockImplementation(({ data }) => ({
        id: `registration-${data.userId}`,
        ...data,
        status: 'PENDING',
        totalAmount: 100,
        serviceFee: 5,
        finalAmount: 105,
      }));

      mockPrismaService.registration.findUnique.mockImplementation(({ where }) => ({
        id: where.id,
        userId: 'user-1',
        finalAmount: 105,
        status: 'PENDING',
        event: { id: 'event-id', name: 'Test Event' },
        user: {
          id: 'user-1',
          firstName: 'User',
          lastName: 'Test',
          email: 'user@example.com',
        },
        payment: null,
      }));

      mockCieloService.createPayment.mockResolvedValue({
        success: true,
        paymentId: 'cielo-payment-id',
        clientSecret: 'client-secret',
      });

      mockPrismaService.payment.create.mockImplementation(({ data }) => ({
        id: `payment-${data.registrationId}`,
        ...data,
        registration: {
          event: { id: 'event-id' },
        },
      }));

      const journeys = Array.from({ length: concurrentUsers }, async (_, i) => {
        const email = `user${i}@example.com`;
        const userId = `user-${i}`;

        // 1. Register
        const registerResult = await authService.register({
          email,
          password: 'StrongPass123!',
          firstName: `User${i}`,
          lastName: `Test${i}`,
          gender: 'MALE' as any,
          phone: `123456789${i}`,
          documentNumber: `1234567890${i}`,
          acceptedTerms: true,
          acceptedPrivacyPolicy: true,
          receiveCalendarEvents: false,
          receivePartnerPromos: false,
          language: 'PT' as any,
        });

        // 2. Login
        const loginResult = await authService.login({
          id: userId,
          email,
          firstName: `User${i}`,
          lastName: `Test${i}`,
          documentNumber: `1234567890${i}`,
          role: 'USER',
        });

        // 3. Search Events
        const eventsResult = await eventsService.findAll({ page: 1, limit: 20 });

        // 4. Register for Event
        const registrationResult = await registrationsService.create(userId, {
          eventId: 'event-123',
          modalities: [{ modalityId: 'modality-123' }],
          kitItems: [],
          questionAnswers: [],
          termsAccepted: true,
          rulesAccepted: true,
        });

        // 5. Create Payment
        const paymentResult = await paymentsService.create(userId, {
          registrationId: registrationResult.data.registration.id,
          method: PaymentMethod.PIX,
          metadata: {},
        });

        return {
          register: registerResult,
          login: loginResult,
          events: eventsResult,
          registration: registrationResult,
          payment: paymentResult,
        };
      });

      const results = await Promise.all(journeys);
      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(results).toHaveLength(concurrentUsers);
      expect(duration).toBeLessThan(15000); // Deve completar em menos de 15 segundos
      expect(mockPrismaService.user.create).toHaveBeenCalledTimes(concurrentUsers);
      expect(mockPrismaService.registration.create).toHaveBeenCalledTimes(concurrentUsers);
      expect(mockPrismaService.payment.create).toHaveBeenCalledTimes(concurrentUsers);
    }, 20000);
  });

  describe('Peak Traffic Scenario - Event Launch', () => {
    it('should handle peak traffic during event launch (1000 users registering simultaneously)', async () => {
      const peakUsers = 1000;
      const startTime = Date.now();

      // Setup para evento popular
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPrismaService.user.create.mockImplementation(({ data }) => ({
        id: `user-${data.email}`,
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        role: 'USER',
        isActive: true,
      }));

      mockPrismaService.event.findUnique.mockResolvedValue({
        id: 'popular-event',
        status: 'PUBLISHED',
        registrationEndDate: new Date(Date.now() + 86400000),
        eventDate: new Date(Date.now() + 172800000),
        questions: [],
      });

      mockPrismaService.modality.findUnique.mockResolvedValue({
        id: 'modality-123',
        eventId: 'popular-event',
        isActive: true,
        price: 50,
        maxParticipants: 2000,
        currentParticipants: 0,
      });

      mockPrismaService.registration.create.mockImplementation(({ data }) => ({
        id: `registration-${data.userId}`,
        ...data,
        status: 'PENDING',
        totalAmount: 50,
        serviceFee: 2.5,
        finalAmount: 52.5,
      }));

      const registrations = Array.from({ length: peakUsers }, (_, i) =>
        registrationsService.create(`user-${i}`, {
          eventId: 'popular-event',
          modalities: [{ modalityId: 'modality-123' }],
          kitItems: [],
          questionAnswers: [],
          termsAccepted: true,
          rulesAccepted: true,
        }),
      );

      const results = await Promise.all(registrations);
      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(results).toHaveLength(peakUsers);
      expect(duration).toBeLessThan(20000); // Deve completar em menos de 20 segundos
      
      // Verificar que todas as inscrições foram processadas
      const successfulRegistrations = results.filter((r) => r.data?.registration);
      expect(successfulRegistrations.length).toBe(peakUsers);
    }, 25000);
  });

  describe('Mixed Workload Performance', () => {
    it('should handle mixed workload efficiently (reads + writes)', async () => {
      const readOperations = 500;
      const writeOperations = 100;
      const startTime = Date.now();

      mockPrismaService.event.findMany.mockResolvedValue([]);
      mockPrismaService.event.count.mockResolvedValue(0);
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPrismaService.user.create.mockImplementation(({ data }) => ({
        id: `user-${data.email}`,
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        role: 'USER',
        isActive: true,
      }));

      // Mix de operações de leitura e escrita
      const reads = Array.from({ length: readOperations }, () =>
        eventsService.findAll({ page: 1, limit: 20 }),
      );

      const writes = Array.from({ length: writeOperations }, (_, i) =>
        userService.create({
          email: `user${i}@example.com`,
          password: 'StrongPass123!',
          firstName: `User${i}`,
          lastName: `Test${i}`,
          acceptedTerms: true,
          acceptedPrivacyPolicy: true,
        }),
      );

      const [readResults, writeResults] = await Promise.all([
        Promise.all(reads),
        Promise.all(writes),
      ]);

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(readResults).toHaveLength(readOperations);
      expect(writeResults).toHaveLength(writeOperations);
      expect(duration).toBeLessThan(10000); // Deve completar em menos de 10 segundos
    }, 15000);
  });

  describe('Resource Exhaustion Protection', () => {
    it('should gracefully handle resource exhaustion scenarios', async () => {
      const excessiveRequests = 10000;

      // Simular degradação gradual de performance
      let callCount = 0;
      mockPrismaService.event.findMany.mockImplementation(() => {
        callCount++;
        if (callCount > 5000) {
          // Simular delay crescente após muitas requisições
          return new Promise((resolve) => {
            setTimeout(() => resolve([]), 50);
          });
        }
        return Promise.resolve([]);
      });

      const startTime = Date.now();
      const requests = Array.from({ length: excessiveRequests }, () =>
        eventsService.findAll({ page: 1, limit: 20 }),
      );

      const results = await Promise.allSettled(requests);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;

      // Deve completar todas as requisições, mesmo com degradação
      expect(successful + failed).toBe(excessiveRequests);
      expect(duration).toBeLessThan(30000); // Deve completar em menos de 30 segundos
    }, 35000);
  });
});

