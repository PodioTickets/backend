import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsService } from '../payments.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { CieloService } from '../cielo.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { PaymentStatus, PaymentMethod } from '@prisma/client';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: PrismaService;
  let cieloService: CieloService;

  const mockPrismaService = {
    registration: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    payment: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };

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
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
    prisma = module.get<PrismaService>(PrismaService);
    cieloService = module.get<CieloService>(CieloService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    const userId = 'user-id';
    const createPaymentDto = {
      registrationId: 'registration-id',
      method: PaymentMethod.PIX,
      metadata: {},
    };

    const mockRegistration = {
      id: 'registration-id',
      userId: userId,
      finalAmount: 100.0,
      status: 'PENDING',
      event: {
        id: 'event-id',
        name: 'Test Event',
      },
      user: {
        id: userId,
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
      },
      payment: null,
    };

    const mockCieloResult = {
      success: true,
      paymentId: 'cielo-payment-id',
      clientSecret: 'client-secret',
      qrCode: 'qr-code',
      pixCode: 'pix-code',
      expiresAt: new Date(),
    };

    const mockPayment = {
      id: 'payment-id',
      registrationId: 'registration-id',
      userId: userId,
      method: PaymentMethod.PIX,
      status: PaymentStatus.PENDING,
      amount: 100.0,
      transactionId: 'cielo-payment-id',
      metadata: {},
      registration: {
        event: {
          id: 'event-id',
        },
      },
    };

    it('should create payment successfully', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue(mockRegistration);
      mockCieloService.createPayment.mockResolvedValue(mockCieloResult);
      mockPrismaService.payment.create.mockResolvedValue(mockPayment);

      const result = await service.create(userId, createPaymentDto);

      expect(result).toHaveProperty('message', 'Payment created successfully');
      expect(result.data.payment).toBeDefined();
      expect(result.data.paymentIntent).toBeDefined();
      expect(mockCieloService.createPayment).toHaveBeenCalledWith(
        100.0,
        'BRL',
        PaymentMethod.PIX,
        'registration-id',
        {
          name: 'John Doe',
          email: 'john@example.com',
        },
      );
      expect(mockPrismaService.payment.create).toHaveBeenCalled();
    });

    it('should throw NotFoundException if registration not found', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue(null);

      await expect(service.create(userId, createPaymentDto)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.create(userId, createPaymentDto)).rejects.toThrow(
        'Registration not found',
      );
    });

    it('should throw BadRequestException if registration does not belong to user', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue({
        ...mockRegistration,
        userId: 'other-user-id',
        invitedById: null,
      });

      await expect(service.create(userId, createPaymentDto)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create(userId, createPaymentDto)).rejects.toThrow(
        'Access denied',
      );
    });

    it('should allow payment if user is the inviter', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue({
        ...mockRegistration,
        userId: 'other-user-id',
        invitedById: userId,
      });
      mockCieloService.createPayment.mockResolvedValue(mockCieloResult);
      mockPrismaService.payment.create.mockResolvedValue(mockPayment);

      const result = await service.create(userId, createPaymentDto);

      expect(result).toHaveProperty('message', 'Payment created successfully');
    });

    it('should throw BadRequestException if registration is cancelled', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue({
        ...mockRegistration,
        status: 'CANCELLED',
      });

      await expect(service.create(userId, createPaymentDto)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create(userId, createPaymentDto)).rejects.toThrow(
        'Registration is cancelled',
      );
    });

    it('should throw BadRequestException if payment already exists', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue({
        ...mockRegistration,
        payment: {
          id: 'existing-payment-id',
        },
      });

      await expect(service.create(userId, createPaymentDto)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create(userId, createPaymentDto)).rejects.toThrow(
        'Payment already exists for this registration',
      );
    });

    it('should throw BadRequestException if Cielo payment creation fails', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue(mockRegistration);
      mockCieloService.createPayment.mockResolvedValue({
        success: false,
        error: 'Cielo error',
      });

      await expect(service.create(userId, createPaymentDto)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('confirmPayment', () => {
    const userId = 'user-id';
    const confirmPaymentDto = {
      paymentId: 'payment-id',
      paymentMethodId: 'payment-method-id',
    };

    const mockPayment = {
      id: 'payment-id',
      userId: userId,
      registrationId: 'registration-id',
      status: PaymentStatus.PENDING,
      transactionId: 'cielo-payment-id',
      metadata: {},
      registration: {
        id: 'registration-id',
      },
    };

    const mockCieloResult = {
      success: true,
      cieloStatus: 'Captured',
    };

    const mockUpdatedPayment = {
      ...mockPayment,
      status: PaymentStatus.PAID,
      paymentDate: new Date(),
    };

    beforeEach(() => {
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        return callback(mockPrismaService);
      });
    });

    it('should confirm payment successfully', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(mockPayment);
      mockCieloService.capturePayment.mockResolvedValue(mockCieloResult);
      mockPrismaService.payment.update.mockResolvedValue(mockUpdatedPayment);
      mockPrismaService.registration.update.mockResolvedValue({});

      const result = await service.confirmPayment(userId, confirmPaymentDto);

      expect(result).toHaveProperty('message', 'Payment confirmed successfully');
      expect(result.data.payment.status).toBe(PaymentStatus.PAID);
      expect(mockCieloService.capturePayment).toHaveBeenCalledWith(
        'cielo-payment-id',
      );
      expect(mockPrismaService.registration.update).toHaveBeenCalledWith({
        where: { id: 'registration-id' },
        data: { status: 'CONFIRMED' },
      });
    });

    it('should throw NotFoundException if payment not found', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(null);

      await expect(
        service.confirmPayment(userId, confirmPaymentDto),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.confirmPayment(userId, confirmPaymentDto),
      ).rejects.toThrow('Payment not found');
    });

    it('should throw BadRequestException if payment does not belong to user', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue({
        ...mockPayment,
        userId: 'other-user-id',
      });

      await expect(
        service.confirmPayment(userId, confirmPaymentDto),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.confirmPayment(userId, confirmPaymentDto),
      ).rejects.toThrow('Access denied');
    });

    it('should throw BadRequestException if payment already processed', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue({
        ...mockPayment,
        status: PaymentStatus.PAID,
      });

      await expect(
        service.confirmPayment(userId, confirmPaymentDto),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.confirmPayment(userId, confirmPaymentDto),
      ).rejects.toThrow('Payment already processed');
    });

    it('should throw BadRequestException if transactionId is missing', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue({
        ...mockPayment,
        transactionId: null,
      });

      await expect(
        service.confirmPayment(userId, confirmPaymentDto),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.confirmPayment(userId, confirmPaymentDto),
      ).rejects.toThrow('Payment intent not found');
    });

    it('should throw BadRequestException if Cielo capture fails', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(mockPayment);
      mockCieloService.capturePayment.mockResolvedValue({
        success: false,
        error: 'Capture failed',
      });

      await expect(
        service.confirmPayment(userId, confirmPaymentDto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('processPayment', () => {
    const userId = 'user-id';
    const processPaymentDto = {
      paymentId: 'payment-id',
      transactionId: 'cielo-payment-id',
      metadata: {},
    };

    const mockPayment = {
      id: 'payment-id',
      userId: userId,
      registrationId: 'registration-id',
      status: PaymentStatus.PENDING,
      transactionId: 'cielo-payment-id',
      metadata: {},
      registration: {
        id: 'registration-id',
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

    beforeEach(() => {
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        return callback(mockPrismaService);
      });
      mockCieloService.mapCieloStatusToPaymentStatus.mockReturnValue(
        PaymentStatus.PAID,
      );
      mockCieloService.mapCieloStatusToString.mockReturnValue('Paid');
    });

    it('should process payment successfully', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(mockPayment);
      mockCieloService.getPayment.mockResolvedValue(mockCieloPayment);
      mockPrismaService.payment.update.mockResolvedValue({
        ...mockPayment,
        status: PaymentStatus.PAID,
      });
      mockPrismaService.registration.update.mockResolvedValue({});

      const result = await service.processPayment(userId, processPaymentDto);

      expect(result).toHaveProperty('message', 'Payment processed successfully');
      expect(mockCieloService.getPayment).toHaveBeenCalledWith('cielo-payment-id');
      expect(mockCieloService.mapCieloStatusToPaymentStatus).toHaveBeenCalledWith(2);
    });

    it('should update registration status if payment is paid', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(mockPayment);
      mockCieloService.getPayment.mockResolvedValue(mockCieloPayment);
      mockCieloService.mapCieloStatusToPaymentStatus.mockReturnValue(
        PaymentStatus.PAID,
      );
      mockPrismaService.payment.update.mockResolvedValue({
        ...mockPayment,
        status: PaymentStatus.PAID,
      });
      mockPrismaService.registration.update.mockResolvedValue({});

      await service.processPayment(userId, processPaymentDto);

      expect(mockPrismaService.registration.update).toHaveBeenCalledWith({
        where: { id: 'registration-id' },
        data: { status: 'CONFIRMED' },
      });
    });

    it('should throw NotFoundException if payment not found', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(null);

      await expect(
        service.processPayment(userId, processPaymentDto),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if Cielo payment not found', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(mockPayment);
      mockCieloService.getPayment.mockResolvedValue(null);

      await expect(
        service.processPayment(userId, processPaymentDto),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.processPayment(userId, processPaymentDto),
      ).rejects.toThrow('Payment not found');
    });
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

    it('should throw BadRequestException if payment does not belong to user', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue({
        ...mockPayment,
        userId: 'other-user-id',
      });

      await expect(service.findOne(paymentId, userId)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.findOne(paymentId, userId)).rejects.toThrow(
        'Access denied',
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

    const mockRegistration = {
      id: registrationId,
      totalAmount: 100.0,
      serviceFee: 10.0,
      discount: 5.0,
      finalAmount: 105.0,
      payment: {
        id: 'payment-id',
        status: PaymentStatus.PENDING,
      },
    };

    it('should return payment summary successfully', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue(mockRegistration);

      const result = await service.getPaymentSummary(registrationId);

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

      await expect(service.getPaymentSummary(registrationId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

