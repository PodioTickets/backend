import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsService } from '../payments.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { CieloService } from '../cielo.service';
import { PaymentGateway } from '../payment.gateway';
import { EmailService } from '../../../common/services/email.service';
import { TicketPdfService } from '../../../common/services/ticket-pdf.service';
import { ReceiptPdfService } from '../../../common/services/receipt-pdf.service';
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
    order: {
      findUnique: jest.fn(),
    },
    organizationMember: {
      findFirst: jest.fn(),
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

  const mockReceiptPdfService = {
    generateReceiptPdf: jest.fn(),
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
        { provide: ReceiptPdfService, useValue: mockReceiptPdfService },
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

  describe('generateReceiptPdf', () => {
    const userId = 'buyer-1';

    const buildOrder = () => ({
      id: 'order-abc12345-aaaa-bbbb-cccc-1234567890ab',
      userId,
      totalAmount: 10000, // subtotal em centavos
      serviceFee: 1000,
      discount: 2000,
      finalAmount: 9000,
      reservedTickets: [
        { ticketId: 'tk-1', batchId: 'b-1', unitPrice: 6000, quantity: 1 },
        { ticketId: 'tk-1', batchId: null, unitPrice: 4000, quantity: 1 },
      ],
      payment: {
        method: 'CREDIT_CARD',
        gateway: 'cielo',
        transactionId: 'txn-1',
        cardBrand: 'visa',
        paymentDate: new Date('2026-05-30T10:00:00.000Z'),
        createdAt: new Date('2026-05-30T09:00:00.000Z'),
      },
      coupon: null,
      voucher: { id: 'v-1', code: 'PROMO10', name: 'Promo' },
      user: { firstName: 'Maria', lastName: 'Silva', documentNumber: '12345678900', country: 'BR' },
      event: {
        id: 'evt-1',
        name: 'Corrida',
        eventDate: new Date('2026-07-01T12:00:00.000Z'),
        location: 'Parque',
        city: 'Maceió',
        state: 'AL',
        organizationId: 'org-1',
        participantFeePercent: 10,
        organization: { name: 'Razão LTDA', tradeName: 'Org X', document: '11222333000144', logoUrl: null },
      },
      registrations: [
        {
          id: 'reg-1',
          participantName: 'João',
          participantEmail: 'joao@x.com',
          user: null,
          tickets: [{ ticketId: 'tk-1', batchId: 'b-1', ticketSnapshot: { name: '10K', category: { name: 'Corrida' } }, ticket: null }],
        },
        {
          id: 'reg-2',
          participantName: null,
          participantEmail: null,
          user: { firstName: 'Ana', lastName: 'Souza', email: 'ana@x.com' },
          tickets: [{ ticketId: 'tk-1', batchId: null, ticketSnapshot: null, ticket: { name: '10K', category: { name: 'Corrida' } } }],
        },
      ],
    });

    it('mapeia o pedido → ReceiptPdfData (preços em centavos, voucher exclusivo) e devolve filename', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue({ orderId: 'order-1' });
      mockPrismaService.order.findUnique.mockResolvedValue(buildOrder());
      mockReceiptPdfService.generateReceiptPdf.mockResolvedValue(Buffer.from('receipt'));

      const result = await service.generateReceiptPdf('reg-1', userId);

      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.fileName).toBe('comprovante-ORDER-AB.pdf');

      const data = mockReceiptPdfService.generateReceiptPdf.mock.calls[0][0];
      expect(data.organization).toMatchObject({ name: 'Org X', document: '11222333000144' });
      expect(data.buyer).toMatchObject({ name: 'Maria Silva', document: '12345678900', country: 'BR' });
      expect(data.event).toMatchObject({ name: 'Corrida', location: 'Maceió - AL, Parque' });
      expect(data.financial).toMatchObject({ subtotal: 10000, discount: 2000, serviceFee: 1000, total: 9000, voucherCode: 'PROMO10' });
      // preço por inscrição: chave ticketId:batchId, fallback por ticketId
      expect(data.registrations).toEqual([
        { id: 'reg-1', participantName: 'João', email: 'joao@x.com', ticketCategory: 'Corrida', ticketName: '10K', price: 6000, products: [] },
        { id: 'reg-2', participantName: 'Ana Souza', email: 'ana@x.com', ticketCategory: 'Corrida', ticketName: '10K', price: 4000, products: [] },
      ]);
    });

    it('autoriza o organizador (membro da org) quando não é o comprador', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue({ orderId: 'order-1' });
      mockPrismaService.order.findUnique.mockResolvedValue(buildOrder());
      mockPrismaService.user.findUnique.mockResolvedValue({ role: 'USER' }); // não-admin
      mockPrismaService.organizationMember.findFirst.mockResolvedValue({ id: 'm-1' });
      mockReceiptPdfService.generateReceiptPdf.mockResolvedValue(Buffer.from('receipt'));

      await expect(service.generateReceiptPdf('reg-1', 'organizer-9')).resolves.toMatchObject({
        fileName: expect.stringContaining('comprovante-'),
      });
      expect(mockPrismaService.organizationMember.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: 'org-1', userId: 'organizer-9' } }),
      );
    });

    it('bloqueia quem não é comprador/admin/organizador', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue({ orderId: 'order-1' });
      mockPrismaService.order.findUnique.mockResolvedValue(buildOrder());
      mockPrismaService.user.findUnique.mockResolvedValue({ role: 'USER' });
      mockPrismaService.organizationMember.findFirst.mockResolvedValue(null);

      await expect(service.generateReceiptPdf('reg-1', 'stranger')).rejects.toThrow(BadRequestException);
      expect(mockReceiptPdfService.generateReceiptPdf).not.toHaveBeenCalled();
    });

    it('lança NotFound quando a inscrição não tem pedido', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue(null);

      await expect(service.generateReceiptPdf('reg-x', userId)).rejects.toThrow(NotFoundException);
    });
  });
});

