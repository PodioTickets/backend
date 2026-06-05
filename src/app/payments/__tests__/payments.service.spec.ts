import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsService } from '../payments.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { CieloService } from '../cielo.service';
import { PaymentGateway } from '../payment.gateway';
import { EmailService } from '../../../common/services/email.service';
import { TicketPdfService } from '../../../common/services/ticket-pdf.service';
import { OrderFinalizationService } from '../order-finalization.service';
import { PaymentCompensationService } from '../payment-compensation.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { PaymentStatus, PaymentMethod } from '@prisma/client';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: PrismaService;
  let cieloService: CieloService;

  const mockPrismaService: any = {
    registration: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    // isAdminUser() consulta user.findUnique — default: não-admin.
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    payment: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  // O service acessa o banco via getReadClient()/getWriteClient() — devolvem o próprio mock.
  mockPrismaService.getReadClient = jest.fn(() => mockPrismaService);
  mockPrismaService.getWriteClient = jest.fn(() => mockPrismaService);

  const mockCieloService = {
    createPayment: jest.fn(),
    capturePayment: jest.fn(),
    getPayment: jest.fn(),
    mapCieloStatusToPaymentStatus: jest.fn(),
    mapCieloStatusToString: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: CieloService,
          useValue: mockCieloService,
        },
        // Deps restantes do construtor — não exercitadas pelos testes atuais.
        { provide: PaymentGateway, useValue: { emitPaymentConfirmed: jest.fn() } },
        { provide: EmailService, useValue: {} },
        { provide: TicketPdfService, useValue: {} },
        { provide: OrderFinalizationService, useValue: { confirmAndFinalizeOrder: jest.fn().mockResolvedValue({ finalized: true, registrations: [] }) } },
        { provide: PaymentCompensationService, useValue: { compensateOrphanPayment: jest.fn() } },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
    prisma = module.get<PrismaService>(PrismaService);
    cieloService = module.get<CieloService>(CieloService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findOne', () => {
    const userId = 'user-id';
    const paymentId = 'payment-id';

    const mockPayment = {
      id: paymentId,
      userId: userId,
      transactionId: 'cielo-payment-id',
      registration: {
        event: {
          id: 'event-id',
        },
        user: {
          id: userId,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
        },
      },
    };

    const mockCieloPayment = {
      Payment: {
        PaymentId: 'cielo-payment-id',
        Status: 2,
        Amount: 10000,
        Currency: 'BRL',
      },
    };

    it('should return payment successfully', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(mockPayment);
      mockCieloService.getPayment.mockResolvedValue(mockCieloPayment);
      mockCieloService.mapCieloStatusToString.mockReturnValue('Paid');

      const result = await service.findOne(paymentId, userId);

      expect(result).toHaveProperty('message', 'Payment fetched successfully');
      expect(result.data.payment).toBeDefined();
      expect(result.data.cieloInfo).toBeDefined();
    });

    it('should throw NotFoundException if payment not found', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(null);

      await expect(service.findOne(paymentId, userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('pagamento de OUTRO usuário → 404 (não vaza existência; antes o teste esperava 400)', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue({
        ...mockPayment,
        userId: 'other-user-id',
      });

      // Comportamento atual e correto (least privilege): responder 404 em vez de 400/403
      // não revela que o pagamento existe para quem não é dono.
      await expect(service.findOne(paymentId, userId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getUserPayments', () => {
    const userId = 'user-id';

    const mockPayments = [
      {
        id: 'payment-1',
        userId: userId,
        createdAt: new Date(),
        registration: {
          event: {
            id: 'event-1',
            name: 'Event 1',
            eventDate: new Date(),
          },
        },
      },
      {
        id: 'payment-2',
        userId: userId,
        createdAt: new Date(),
        registration: {
          event: {
            id: 'event-2',
            name: 'Event 2',
            eventDate: new Date(),
          },
        },
      },
    ];

    it('should return user payments successfully', async () => {
      mockPrismaService.payment.findMany.mockResolvedValue(mockPayments);

      const result = await service.getUserPayments(userId);

      expect(result).toHaveProperty('message', 'Payments fetched successfully');
      expect(result.data.payments).toEqual(mockPayments);
      expect(mockPrismaService.payment.findMany).toHaveBeenCalledWith({
        where: { userId },
        include: expect.any(Object),
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('getPaymentSummary', () => {
    const registrationId = 'registration-id';
    const userId = 'test-user-id';

    /* Após o fix de IDOR, getPaymentSummary exige userId. O mock simula um
     * registration cujo order.userId === userId (comprador autorizado). */
    const mockRegistration = {
      id: registrationId,
      userId,
      order: {
        userId,
        totalAmount: 100.0,
        serviceFee: 10.0,
        discount: 5.0,
        finalAmount: 105.0,
        payment: {
          id: 'payment-id',
          status: PaymentStatus.PENDING,
        },
      },
      event: {
        organization: { members: [] },
      },
    };

    it('should return payment summary successfully', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue(mockRegistration);

      const result = await service.getPaymentSummary(registrationId, userId);

      expect(result).toHaveProperty(
        'message',
        'Payment summary fetched successfully',
      );
      expect(result.data.totalAmount).toBe(100.0);
      expect(result.data.serviceFee).toBe(10.0);
      expect(result.data.discount).toBe(5.0);
      expect(result.data.finalAmount).toBe(105.0);
      expect(result.data.payment).toBeDefined();
    });

    it('should throw NotFoundException if registration not found', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue(null);

      await expect(
        service.getPaymentSummary(registrationId, userId),
      ).rejects.toThrow(NotFoundException);
    });
  });
});

