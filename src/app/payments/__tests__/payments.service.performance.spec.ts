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

/**
 * Spec de performance do PaymentsService.
 *
 * Atualizações vs. versão legada:
 *  - O service hoje tem 7 deps no construtor (Prisma, Cielo, PaymentGateway,
 *    Email, TicketPdf, OrderFinalization, PaymentCompensation) — todas providas
 *    como mocks.
 *  - findOne() usa o modelo Order (payment.order...), não mais
 *    payment.registration. O mock de payment.findUnique reflete isso.
 *  - findOne usa getReadClient(); o mock do Prisma expõe getReadClient/getWriteClient.
 *  - Tipagem do resultado do .catch() ajustada (a união não tem `.error`):
 *    usamos um type guard ('error' in r) em vez de acessar r.error direto.
 */
describe('PaymentsService - Performance Tests', () => {
  let service: PaymentsService;

  const mockPrismaService = {
    payment: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
    getReadClient: jest.fn(),
    getWriteClient: jest.fn(),
  };

  const mockCieloService = {
    getPayment: jest.fn(),
    mapCieloStatusToString: jest.fn(),
    mapCieloStatusToPaymentStatus: jest.fn(),
  };

  const mockGateway = { emitPaymentConfirmed: jest.fn() };
  const mockEmailService = { sendRegistrationConfirmed: jest.fn() };
  const mockTicketPdfService = { generateTicketPdf: jest.fn() };
  const mockReceiptPdfService = { generateReceiptPdf: jest.fn() };
  const mockOrderFinalization = { confirmAndFinalizeOrder: jest.fn() };
  const mockCompensation = { compensateOrphanPayment: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: CieloService, useValue: mockCieloService },
        { provide: PaymentGateway, useValue: mockGateway },
        { provide: EmailService, useValue: mockEmailService },
        { provide: TicketPdfService, useValue: mockTicketPdfService },
        { provide: ReceiptPdfService, useValue: mockReceiptPdfService },
        { provide: OrderFinalizationService, useValue: mockOrderFinalization },
        { provide: PaymentCompensationService, useValue: mockCompensation },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);

    mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
    mockPrismaService.getWriteClient.mockReturnValue(mockPrismaService);
    mockPrismaService.$transaction.mockImplementation(async (cb: any) => cb(mockPrismaService));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('High Concurrency - Payment Queries', () => {
    beforeEach(() => {
      // findOne carrega payment + order (event/org/members) + registrations.
      // userId === payment.userId garante autorização sem hit no user.findUnique.
      mockPrismaService.payment.findUnique.mockImplementation(({ where }: any) => ({
        id: where.id,
        userId: 'user-owner',
        transactionId: 'cielo-payment-id',
        order: {
          event: { organization: { members: [] } },
          registrations: [],
        },
      }));

      mockCieloService.getPayment.mockResolvedValue({
        Payment: {
          PaymentId: 'cielo-payment-id',
          Status: 2,
          Amount: 10000,
          Currency: 'BRL',
        },
      });
      mockCieloService.mapCieloStatusToString.mockReturnValue('Paid');
    });

    it('should handle 2000 concurrent payment queries efficiently', async () => {
      const concurrentRequests = 2000;
      const startTime = Date.now();

      // Mesmo userId do payment ('user-owner') para passar na autorização.
      const promises = Array.from({ length: concurrentRequests }, (_, i) => {
        return service
          .findOne(`payment-${i}`, 'user-owner')
          .catch((error) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      // Type guard: a união (sucesso | { error }) não tem `.error` no ramo de sucesso.
      const successful = results.filter((r) => !('error' in r)).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(10000); // Reads should be fast
      expect(throughput).toBeGreaterThan(100); // At least 100 reads per second

      console.log(`✅ Processed ${concurrentRequests} concurrent payment queries:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 15000);
  });
});
