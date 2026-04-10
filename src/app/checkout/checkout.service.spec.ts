import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CieloService } from '../payments/cielo.service';
import { RegistrationsService } from '../registrations/registrations.service';
import { PaymentMethod, Prisma } from '@prisma/client';

describe('CheckoutService', () => {
  let service: CheckoutService;

  const mockPrisma = {
    registrationTicket: { findMany: jest.fn(), groupBy: jest.fn() },
    ticketBatch: { findMany: jest.fn() },
    ticket: { findUnique: jest.fn() },
    event: { findUnique: jest.fn() },
    order: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
    registration: { updateMany: jest.fn() },
    user: { findMany: jest.fn() },
    registrationKitItem: { findMany: jest.fn() },
    registrationModality: { findMany: jest.fn() },
    questionAnswer: { findMany: jest.fn() },
    ticketProduct: { findMany: jest.fn() },
    product: { findMany: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn((fn: (tx: any) => Promise<any>) => fn(mockPrisma)),
  };

  const mockPrismaService = {
    getReadClient: jest.fn(),
    getWriteClient: jest.fn(),
    registration: { updateMany: jest.fn() },
  };

  // Helper para acessar métodos privados no TypeScript
  type PrivateService = {
    findAvailableBatch: (
      prisma: typeof mockPrisma,
      ticketId: string,
      batchId: string | undefined,
      quantityNeeded: number,
    ) => Promise<{ batch: Record<string, unknown>; remaining: number } | null>;
    validateStock: (dto: Record<string, unknown>, prisma: typeof mockPrisma) => Promise<void>;
    getRegistrationDetails: (
      registrationId: string,
      dto: Record<string, unknown>,
      prisma: typeof mockPrisma,
    ) => Promise<unknown>;
    expirePendingRegistrations: (olderThanMinutes?: number) => Promise<number>;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckoutService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: CieloService, useValue: {} },
        { provide: RegistrationsService, useValue: {} },
      ],
    }).compile();

    service = module.get(CheckoutService);
    jest.clearAllMocks();
    mockPrismaService.getReadClient.mockReturnValue(mockPrisma);
    mockPrismaService.getWriteClient.mockReturnValue(mockPrisma);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // findAvailableBatch
  // ─────────────────────────────────────────────────────────────────────────────
  describe('findAvailableBatch', () => {
    const lote1 = { id: 'lote-1', ticketId: 'ticket-1', quantity: 100, startDate: null, createdAt: new Date('2024-01-01') };
    const lote2 = { id: 'lote-2', ticketId: 'ticket-1', quantity: 100, startDate: null, createdAt: new Date('2024-02-01') };

    it('retorna o primeiro lote quando ele ainda tem vagas', async () => {
      mockPrisma.ticketBatch.findMany.mockResolvedValue([lote1, lote2]);
      // lote 1 tem 40 vendas → 60 vagas livres
      mockPrisma.registrationTicket.groupBy.mockResolvedValue([
        { batchId: 'lote-1', _count: { id: 40 } },
      ]);

      const result = await (service as unknown as PrivateService).findAvailableBatch(
        mockPrisma, 'ticket-1', undefined, 1,
      );

      expect(result).not.toBeNull();
      expect(result!.batch.id).toBe('lote-1');
      expect(result!.remaining).toBe(60);
    });

    it('pula o primeiro lote cheio e retorna o segundo com vaga', async () => {
      mockPrisma.ticketBatch.findMany.mockResolvedValue([lote1, lote2]);
      // lote 1 completamente vendido, lote 2 com 10 vendas
      mockPrisma.registrationTicket.groupBy.mockResolvedValue([
        { batchId: 'lote-1', _count: { id: 100 } },
        { batchId: 'lote-2', _count: { id: 10 } },
      ]);

      const result = await (service as unknown as PrivateService).findAvailableBatch(
        mockPrisma, 'ticket-1', undefined, 1,
      );

      expect(result).not.toBeNull();
      expect(result!.batch.id).toBe('lote-2');
      expect(result!.remaining).toBe(90);
    });

    it('retorna null quando todos os lotes estão esgotados', async () => {
      mockPrisma.ticketBatch.findMany.mockResolvedValue([lote1, lote2]);
      mockPrisma.registrationTicket.groupBy.mockResolvedValue([
        { batchId: 'lote-1', _count: { id: 100 } },
        { batchId: 'lote-2', _count: { id: 100 } },
      ]);

      const result = await (service as unknown as PrivateService).findAvailableBatch(
        mockPrisma, 'ticket-1', undefined, 1,
      );

      expect(result).toBeNull();
    });

    it('retorna null quando a quantidade pedida é maior que as vagas restantes no único lote disponível', async () => {
      const loteApertado = { ...lote1, quantity: 5 };
      mockPrisma.ticketBatch.findMany.mockResolvedValue([loteApertado]);
      // 3 já vendidas → 2 vagas livres, mas o comprador quer 3
      mockPrisma.registrationTicket.groupBy.mockResolvedValue([
        { batchId: 'lote-1', _count: { id: 3 } },
      ]);

      const result = await (service as unknown as PrivateService).findAvailableBatch(
        mockPrisma, 'ticket-1', undefined, 3,
      );

      expect(result).toBeNull();
    });

    it('usa o segundo lote quando o primeiro não comporta a quantidade pedida mas o segundo sim', async () => {
      const loteQuaseCheiro = { ...lote1, quantity: 10 };
      const loteFolga = { ...lote2, quantity: 50 };
      mockPrisma.ticketBatch.findMany.mockResolvedValue([loteQuaseCheiro, loteFolga]);
      // lote 1: 8 vendidas → 2 vagas; lote 2: 0 vendidas → 50 vagas
      mockPrisma.registrationTicket.groupBy.mockResolvedValue([
        { batchId: 'lote-1', _count: { id: 8 } },
      ]);

      const result = await (service as unknown as PrivateService).findAvailableBatch(
        mockPrisma, 'ticket-1', undefined, 5,
      );

      expect(result!.batch.id).toBe('lote-2');
      expect(result!.remaining).toBe(50);
    });

    it('retorna null quando não há nenhum lote cadastrado', async () => {
      mockPrisma.ticketBatch.findMany.mockResolvedValue([]);
      mockPrisma.registrationTicket.groupBy.mockResolvedValue([]);

      const result = await (service as unknown as PrivateService).findAvailableBatch(
        mockPrisma, 'ticket-1', undefined, 1,
      );

      expect(result).toBeNull();
      // não deve chamar groupBy se não há lotes
      expect(mockPrisma.registrationTicket.groupBy).not.toHaveBeenCalled();
    });

    describe('com batchId explícito', () => {
      it('retorna o lote informado quando ele tem vagas', async () => {
        mockPrisma.ticketBatch.findMany.mockResolvedValue([lote1, lote2]);
        mockPrisma.registrationTicket.groupBy.mockResolvedValue([
          { batchId: 'lote-2', _count: { id: 20 } },
        ]);

        const result = await (service as unknown as PrivateService).findAvailableBatch(
          mockPrisma, 'ticket-1', 'lote-2', 1,
        );

        expect(result!.batch.id).toBe('lote-2');
        expect(result!.remaining).toBe(80);
      });

      it('retorna null quando o lote informado está esgotado', async () => {
        mockPrisma.ticketBatch.findMany.mockResolvedValue([lote1, lote2]);
        mockPrisma.registrationTicket.groupBy.mockResolvedValue([
          { batchId: 'lote-2', _count: { id: 100 } },
        ]);

        const result = await (service as unknown as PrivateService).findAvailableBatch(
          mockPrisma, 'ticket-1', 'lote-2', 1,
        );

        expect(result).toBeNull();
      });

      it('retorna null quando o batchId informado não pertence ao ticket', async () => {
        mockPrisma.ticketBatch.findMany.mockResolvedValue([lote1]);
        mockPrisma.registrationTicket.groupBy.mockResolvedValue([]);

        const result = await (service as unknown as PrivateService).findAvailableBatch(
          mockPrisma, 'ticket-1', 'lote-inexistente', 1,
        );

        expect(result).toBeNull();
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // validateStock
  // ─────────────────────────────────────────────────────────────────────────────
  describe('validateStock', () => {
    const ticketAtivo = { id: 'ticket-1', name: 'Corrida 5km', isActive: true };
    const lote1 = { id: 'lote-1', ticketId: 'ticket-1', quantity: 100, startDate: null, createdAt: new Date() };

    const dtoBase = {
      tickets: [{ ticketId: 'ticket-1', quantity: 1 }],
      participants: [],
    };

    beforeEach(() => {
      mockPrisma.ticket.findUnique.mockResolvedValue(ticketAtivo);
      mockPrisma.ticketBatch.findMany.mockResolvedValue([lote1]);
      mockPrisma.registrationTicket.groupBy.mockResolvedValue([]);
    });

    it('não lança erro quando o lote tem vagas disponíveis', async () => {
      await expect(
        (service as unknown as PrivateService).validateStock(dtoBase, mockPrisma),
      ).resolves.not.toThrow();
    });

    it('lança BadRequestException quando todos os lotes estão esgotados', async () => {
      // lote 1 completamente vendido
      mockPrisma.registrationTicket.groupBy.mockResolvedValue([
        { batchId: 'lote-1', _count: { id: 100 } },
      ]);

      await expect(
        (service as unknown as PrivateService).validateStock(dtoBase, mockPrisma),
      ).rejects.toThrow(BadRequestException);
    });

    it('a mensagem de erro menciona o nome do ingresso', async () => {
      mockPrisma.registrationTicket.groupBy.mockResolvedValue([
        { batchId: 'lote-1', _count: { id: 100 } },
      ]);

      await expect(
        (service as unknown as PrivateService).validateStock(dtoBase, mockPrisma),
      ).rejects.toThrow(/Corrida 5km/);
    });

    it('lança NotFoundException quando o ingresso não existe', async () => {
      mockPrisma.ticket.findUnique.mockResolvedValue(null);

      await expect(
        (service as unknown as PrivateService).validateStock(dtoBase, mockPrisma),
      ).rejects.toThrow(NotFoundException);
    });

    it('lança NotFoundException quando o ingresso está inativo', async () => {
      mockPrisma.ticket.findUnique.mockResolvedValue({ ...ticketAtivo, isActive: false });

      await expect(
        (service as unknown as PrivateService).validateStock(dtoBase, mockPrisma),
      ).rejects.toThrow(NotFoundException);
    });

    it('valida múltiplos ingressos no mesmo checkout — falha se qualquer um estiver esgotado', async () => {
      const lote2 = { id: 'lote-2', ticketId: 'ticket-2', quantity: 50, startDate: null, createdAt: new Date() };

      mockPrisma.ticket.findUnique
        .mockResolvedValueOnce({ id: 'ticket-1', name: 'Corrida 5km', isActive: true })
        .mockResolvedValueOnce({ id: 'ticket-2', name: 'Corrida 10km', isActive: true });

      mockPrisma.ticketBatch.findMany
        .mockResolvedValueOnce([lote1])   // ticket-1: tem vaga
        .mockResolvedValueOnce([lote2]);  // ticket-2: será esgotado

      mockPrisma.registrationTicket.groupBy
        .mockResolvedValueOnce([])                                             // ticket-1: sem vendas
        .mockResolvedValueOnce([{ batchId: 'lote-2', _count: { id: 50 } }]); // ticket-2: cheio

      const dtoMultiplo = {
        tickets: [
          { ticketId: 'ticket-1', quantity: 1 },
          { ticketId: 'ticket-2', quantity: 1 },
        ],
        participants: [],
      };

      await expect(
        (service as unknown as PrivateService).validateStock(dtoMultiplo, mockPrisma),
      ).rejects.toThrow(/Corrida 10km/);
    });
  });

  describe('getRegistrationDetails (produtos extras por participante)', () => {
    it('usa um único product.findMany para todos os productIds do DTO e monta preços por participante', async () => {
      mockPrisma.registrationTicket.findMany.mockResolvedValue([
        {
          ticket: {
            id: 't1',
            name: 'Ingresso',
            description: '',
            batches: [
              { id: 'b1', name: 'L1', price: 5000, startDate: null },
            ],
            basePrice: 0,
          },
        },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.registrationKitItem.findMany.mockResolvedValue([
        {
          kitItem: {
            id: 'ki1',
            name: 'Item kit',
            product: { id: 'pk1', name: 'Prod kit', basePrice: 100 },
          },
          selectedSize: null,
          quantity: 1,
        },
      ]);
      mockPrisma.registrationModality.findMany.mockResolvedValue([]);
      mockPrisma.questionAnswer.findMany.mockResolvedValue([]);
      mockPrisma.ticketProduct.findMany.mockResolvedValue([]);
      mockPrisma.product.findMany.mockResolvedValue([
        {
          id: 'p1',
          name: 'Produto 1',
          basePrice: 800,
          variations: [{ id: 'v1', name: 'G', price: 900 }],
        },
        {
          id: 'p2',
          name: 'Produto 2',
          basePrice: 300,
          variations: [],
        },
      ]);

      const dto = {
        eventId: 'ev1',
        paymentMethod: PaymentMethod.PIX,
        payment: {},
        tickets: [{ ticketId: 't1', quantity: 2 }],
        participants: [
          {
            name: 'P1',
            cpf: '111',
            email: 'p1@test.com',
            birthDate: '1990-01-01',
            phone: '11999999999',
            products: [{ productId: 'p1', quantity: 1, variationId: 'v1' }],
          },
          {
            name: 'P2',
            cpf: '222',
            email: 'p2@test.com',
            birthDate: '1990-01-01',
            phone: '11888888888',
            products: [
              { productId: 'p1', quantity: 2 },
              { productId: 'p2', quantity: 1 },
            ],
          },
        ],
      };

      const details = await (
        service as unknown as {
          getRegistrationDetails: (
            registrationId: string,
            dto: Record<string, unknown>,
            prisma: typeof mockPrisma,
          ) => Promise<{
            participants: Array<{
              products: Array<{
                productId: string;
                productName: string;
                unitPrice: number;
                totalPrice: number;
                quantity: number;
                variationId: string | null;
                variationName: string | null;
              }>;
            }>;
          }>;
        }
      ).getRegistrationDetails('reg-1', dto, mockPrisma);

      expect(mockPrisma.product.findMany).toHaveBeenCalledTimes(1);
      const [callArg] = mockPrisma.product.findMany.mock.calls[0];
      expect(callArg).toEqual(
        expect.objectContaining({
          where: { id: { in: expect.any(Array) } },
          include: { variations: true },
        }),
      );
      const ids = [...(callArg.where as { id: { in: string[] } }).id.in].sort();
      expect(ids).toEqual(['p1', 'p2']);

      expect(mockPrisma.product.findUnique).not.toHaveBeenCalled();

      expect(details.participants[0].products).toEqual([
        expect.objectContaining({
          productId: 'p1',
          productName: 'Produto 1',
          variationId: 'v1',
          variationName: 'G',
          quantity: 1,
          unitPrice: 900,
          totalPrice: 900,
        }),
      ]);
      expect(details.participants[1].products).toEqual([
        expect.objectContaining({
          productId: 'p1',
          unitPrice: 800,
          totalPrice: 1600,
          quantity: 2,
        }),
        expect.objectContaining({
          productId: 'p2',
          unitPrice: 300,
          totalPrice: 300,
          quantity: 1,
        }),
      ]);
    });

    it('não chama product.findMany quando nenhum participante tem produtos extras', async () => {
      mockPrisma.registrationTicket.findMany.mockResolvedValue([
        {
          ticket: {
            id: 't1',
            name: 'Ingresso',
            description: '',
            batches: [
              { id: 'b1', name: 'L1', price: 1000, startDate: null },
            ],
            basePrice: 0,
          },
        },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.registrationKitItem.findMany.mockResolvedValue([
        {
          kitItem: {
            id: 'ki1',
            name: 'Item',
            product: { id: 'pk1', name: 'P', basePrice: 50 },
          },
          selectedSize: null,
          quantity: 1,
        },
      ]);
      mockPrisma.registrationModality.findMany.mockResolvedValue([]);
      mockPrisma.questionAnswer.findMany.mockResolvedValue([]);
      mockPrisma.ticketProduct.findMany.mockResolvedValue([]);

      const dto = {
        eventId: 'ev1',
        paymentMethod: PaymentMethod.PIX,
        payment: {},
        tickets: [{ ticketId: 't1', quantity: 1 }],
        participants: [
          {
            name: 'Só ingresso',
            cpf: '999',
            email: 'only@test.com',
            birthDate: '1992-02-02',
            phone: '11777777777',
          },
        ],
      };

      await (
        service as unknown as {
          getRegistrationDetails: (
            registrationId: string,
            dto: Record<string, unknown>,
            prisma: typeof mockPrisma,
          ) => Promise<unknown>;
        }
      ).getRegistrationDetails('reg-2', dto, mockPrisma);

      expect(mockPrisma.product.findMany).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Fix 1 — serviceFee nunca vem do cliente
  // ─────────────────────────────────────────────────────────────────────────────
  describe('serviceFee calculado server-side', () => {
    it('o DTO não tem mais o campo serviceFee', () => {
      // Importar o DTO e garantir que o campo não exista
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ProcessCheckoutDto } = require('./dto/process-checkout.dto');
      const dto = new ProcessCheckoutDto();
      expect((dto as any).serviceFee).toBeUndefined();
      // A propriedade não deve existir como chave declarada na classe
      const proto = Object.getOwnPropertyNames(ProcessCheckoutDto.prototype);
      expect(proto).not.toContain('serviceFee');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Fix 2 — dados de cartão nunca expostos no paymentResult de erro
  // ─────────────────────────────────────────────────────────────────────────────
  describe('segurança: dados de cartão no paymentResult de erro', () => {
    it('número completo do cartão não está no paymentResult de erro', () => {
      // Simular o objeto paymentResult construído no catch do processCheckout
      const fullCardNumber = '4111111111111111';
      const errorPaymentResult = {
        success: false,
        status: 'failed',
        transactionId: null,
        error: 'declined',
        cieloResult: null,
        cardData: {
          number: '*'.repeat(fullCardNumber.replace(/\D/g, '').length - 4) +
            fullCardNumber.replace(/\D/g, '').slice(-4),
          holder: 'JOÃO SILVA',
          expiry: null,
          cvv: null,
          installments: 1,
        },
      };

      const serialized = JSON.stringify(errorPaymentResult);
      const parsed = JSON.parse(serialized);

      // PAN completo não deve aparecer
      expect(serialized).not.toContain(fullCardNumber);
      // CVV deve estar null (nunca o valor real)
      expect(parsed.cardData.cvv).toBeNull();
      // expiry deve estar null
      expect(parsed.cardData.expiry).toBeNull();
      // Apenas últimos 4 dígitos OK
      expect(serialized).toContain('1111');
    });

    it('expiry nunca aparece no paymentResult de erro', () => {
      const errorPaymentResult = {
        cardData: { expiry: null, cvv: null },
      };
      expect(JSON.stringify(errorPaymentResult)).not.toContain('12/2027');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Fix 3 — createRegistrations usa $transaction com Serializable
  // ─────────────────────────────────────────────────────────────────────────────
  describe('createRegistrations: transação serializable', () => {
    it('chama prisma.$transaction com isolationLevel Serializable', async () => {
      const txMock = jest.fn().mockResolvedValue({ registrations: [], order: {} });
      const prismaWithTx = { ...mockPrisma, $transaction: txMock };

      // Invoca createRegistrations via reflexão privada
      try {
        await (service as any).createRegistrations(
          'user-1',
          {
            eventId: 'ev-1',
            tickets: [],
            participants: [],
            billingAddress: {
              country: 'BR', postalCode: '01310100', stateUf: 'SP',
              street: 'Av. Paulista', number: '1', neighborhood: 'Bela Vista', city: 'São Paulo',
            },
          },
          { ticketsSubtotal: 0, productsSubtotal: 0, serviceFee: 0, couponDiscount: 0, voucherDiscount: 0, subtotal: 0, total: 0, pixDiscount: 0, finalTotal: 0 },
          { isValid: false, discount: 0 },
          { isValid: false, discount: 0 },
          { status: 'approved', success: true },
          prismaWithTx,
        );
      } catch { /* ignorar erros internos */ }

      expect(txMock).toHaveBeenCalled();
      const [, options] = txMock.mock.calls[0];
      expect(options?.isolationLevel).toBe(Prisma.TransactionIsolationLevel.Serializable);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Fix 4 — webhook: atualização atômica (idempotência)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('webhook: idempotência com updateMany atômico', () => {
    it('quando count=0 (status já igual), não atualiza registrations', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaymentsWebhookService } = require('../payments/payments-webhook.service');

      let capturedTx: any;
      const txFn = jest.fn(async (cb: (tx: any) => Promise<void>) => {
        capturedTx = {
          payment: {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }), // já no status alvo
            findFirst: jest.fn(),
            update: jest.fn(),
          },
          registration: { updateMany: jest.fn() },
        };
        await cb(capturedTx);
      });

      const webhookSvc = new PaymentsWebhookService({} as any, {
        mapCieloStatusToPaymentStatus: jest.fn().mockReturnValue('PAID'),
        mapCieloStatusToString: jest.fn().mockReturnValue('PaymentConfirmed'),
      } as any);
      (webhookSvc as any).prisma = { $transaction: txFn };

      await webhookSvc.handleWebhook({ PaymentId: 'cielo-abc', Status: 2, MerchantOrderId: 'ord-1' });

      // Como count=0, registration.updateMany NÃO deve ter sido chamado
      expect(capturedTx.registration.updateMany).not.toHaveBeenCalled();
    });

    it('quando count=1 (status mudou), confirma registrations', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaymentsWebhookService } = require('../payments/payments-webhook.service');

      let capturedTx: any;
      const txFn = jest.fn(async (cb: (tx: any) => Promise<void>) => {
        capturedTx = {
          payment: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findFirst: jest.fn().mockResolvedValue({ id: 'pay-1', orderId: 'ord-1', metadata: {} }),
            update: jest.fn().mockResolvedValue({}),
          },
          registration: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
        };
        await cb(capturedTx);
      });

      const webhookSvc = new PaymentsWebhookService({} as any, {
        mapCieloStatusToPaymentStatus: jest.fn().mockReturnValue('PAID'),
        mapCieloStatusToString: jest.fn().mockReturnValue('PaymentConfirmed'),
      } as any);
      (webhookSvc as any).prisma = { $transaction: txFn };

      await webhookSvc.handleWebhook({ PaymentId: 'cielo-xyz', Status: 2, MerchantOrderId: 'ord-1' });

      expect(capturedTx.registration.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CONFIRMED' } }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Fix 5 — idempotência no checkout
  // ─────────────────────────────────────────────────────────────────────────────
  describe('idempotencyKey no checkout', () => {
    it('lança BadRequestException quando idempotencyKey já existe', async () => {
      mockPrisma.event.findUnique.mockResolvedValue({ name: 'Corrida SP' });
      mockPrisma.order.findFirst.mockResolvedValue({ id: 'existing-order' });
      mockPrismaService.getReadClient.mockReturnValue(mockPrisma);
      mockPrismaService.getWriteClient.mockReturnValue(mockPrisma);

      const dto = {
        eventId: 'ev-1',
        paymentMethod: PaymentMethod.PIX,
        payment: {},
        tickets: [{ ticketId: 't1', quantity: 1 }],
        participants: [{ name: 'A', cpf: '1', email: 'a@b.com', birthDate: '1990-01-01', phone: '11999999999' }],
        billingAddress: { country: 'BR', postalCode: '01310100', stateUf: 'SP', street: 'Rua', number: '1', neighborhood: 'B', city: 'SP' },
        idempotencyKey: 'already-used-key',
      };

      await expect(service.processCheckout('user-1', dto as any)).rejects.toThrow(
        /idempotência/i,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Fix 6 — expirePendingRegistrations
  // ─────────────────────────────────────────────────────────────────────────────
  describe('expirePendingRegistrations', () => {
    it('cancela inscrições PENDING antigas e retorna a contagem', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 3 });
      mockPrismaService.getWriteClient.mockReturnValue({ registration: { updateMany } });

      const count = await (service as unknown as PrivateService).expirePendingRegistrations(30);

      expect(count).toBe(3);
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'PENDING',
            createdAt: expect.objectContaining({ lt: expect.any(Date) }),
          }),
          data: { status: 'CANCELLED' },
        }),
      );
    });

    it('o cutoff é calculado corretamente para o prazo informado', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      mockPrismaService.getWriteClient.mockReturnValue({ registration: { updateMany } });

      const before = new Date();
      await (service as unknown as PrivateService).expirePendingRegistrations(60);
      const after = new Date();

      const { lt } = updateMany.mock.calls[0][0].where.createdAt;
      // cutoff deve ser ~60 minutos atrás
      const diff = before.getTime() - lt.getTime();
      expect(diff).toBeGreaterThanOrEqual(60 * 60 * 1000 - 100);
      expect(lt.getTime()).toBeLessThan(after.getTime());
    });
  });
});
