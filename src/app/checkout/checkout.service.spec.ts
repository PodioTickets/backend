import { Test, TestingModule } from '@nestjs/testing';
import { CheckoutService } from './checkout.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CieloService } from '../payments/cielo.service';
import { RegistrationsService } from '../registrations/registrations.service';
import { PaymentMethod } from '@prisma/client';

describe('CheckoutService', () => {
  let service: CheckoutService;

  const mockPrisma = {
    registrationTicket: { findMany: jest.fn() },
    user: { findMany: jest.fn() },
    registrationKitItem: { findMany: jest.fn() },
    registrationModality: { findMany: jest.fn() },
    questionAnswer: { findMany: jest.fn() },
    ticketProduct: { findMany: jest.fn() },
    product: { findMany: jest.fn(), findUnique: jest.fn() },
  };

  const mockPrismaService = {
    getReadClient: jest.fn(),
    getWriteClient: jest.fn(),
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
});
