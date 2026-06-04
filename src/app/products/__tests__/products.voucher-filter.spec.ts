/**
 * ROTEIRO — ?voucher=CODE na listagem pública de produtos
 * ========================================================
 * O front, no fluxo de checkout via link de voucher, repassa `?voucher=CODE` para
 * GET /products/events/:eventId. Antes, o ValidationPipe (whitelist) devolvia
 * "property voucher should not exist" (400 genérico). Agora o DTO aceita o campo e o
 * service valida o voucher ANTES de listar, devolvendo erro tipado amigável:
 *
 *  A. Voucher USED        → 422 VOUCHER_ALREADY_USED  "Este voucher já foi utilizado"
 *  B. Voucher expirado    → 422 VOUCHER_EXPIRED       (status EXPIRED ou expiryDate no passado)
 *  C. Inexistente/inválido→ 422 VOUCHER_NOT_FOUND     (não existe, de OUTRO evento, soft-deleted, INACTIVE)
 *  D. Voucher ACTIVE      → lista produtos normalmente (reserva de outro pedido NÃO barra aqui)
 *  E. Sem voucher na query→ nem consulta a tabela de voucher (zero custo extra)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { UnprocessableEntityException } from '@nestjs/common';
import { ProductsService } from '../products.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrganizationsService } from '../../organizations/organizations.service';
import { UploadService } from '../../upload/upload.service';

describe('ProductsService — findAll com ?voucher=CODE', () => {
  let service: ProductsService;
  let client: any;

  const mockPrisma = { getReadClient: jest.fn(), getWriteClient: jest.fn() };
  const EVENT_ID = 'evt-1';

  /** Extrai o body ({code, message}) de uma UnprocessableEntityException. */
  async function expect422(promise: Promise<unknown>, code: string) {
    try {
      await promise;
      fail('esperava UnprocessableEntityException');
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      expect((e as UnprocessableEntityException).getResponse()).toMatchObject({ code });
    }
  }

  beforeEach(async () => {
    client = {
      voucher: { findUnique: jest.fn() },
      product: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    mockPrisma.getReadClient.mockReturnValue(client);
    mockPrisma.getWriteClient.mockReturnValue(client);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrganizationsService, useValue: {} },
        { provide: UploadService, useValue: {} },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── A. Voucher já utilizado ────────────────────────────────────────────────
  it('A. voucher USED → 422 VOUCHER_ALREADY_USED ("Este voucher já foi utilizado")', async () => {
    client.voucher.findUnique.mockResolvedValue({
      eventId: EVENT_ID, status: 'USED', expiryDate: null, deletedAt: null,
    });

    try {
      await service.findAll(EVENT_ID, { voucher: 'FVFJ0MAO' });
      fail('esperava UnprocessableEntityException');
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      expect((e as UnprocessableEntityException).getResponse()).toEqual({
        code: 'VOUCHER_ALREADY_USED',
        message: 'Este voucher já foi utilizado',
      });
    }
    // Não chegou a listar produtos.
    expect(client.product.findMany).not.toHaveBeenCalled();
  });

  // ── B. Expirado ────────────────────────────────────────────────────────────
  it('B1. status EXPIRED → 422 VOUCHER_EXPIRED', async () => {
    client.voucher.findUnique.mockResolvedValue({
      eventId: EVENT_ID, status: 'EXPIRED', expiryDate: null, deletedAt: null,
    });
    await expect422(service.findAll(EVENT_ID, { voucher: 'ABC' }), 'VOUCHER_EXPIRED');
  });

  it('B2. ACTIVE mas expiryDate no passado → 422 VOUCHER_EXPIRED', async () => {
    client.voucher.findUnique.mockResolvedValue({
      eventId: EVENT_ID, status: 'ACTIVE', expiryDate: new Date('2020-01-01'), deletedAt: null,
    });
    await expect422(service.findAll(EVENT_ID, { voucher: 'ABC' }), 'VOUCHER_EXPIRED');
  });

  // ── C. Inexistente / inválido ──────────────────────────────────────────────
  it('C1. código inexistente → 422 VOUCHER_NOT_FOUND', async () => {
    client.voucher.findUnique.mockResolvedValue(null);
    await expect422(service.findAll(EVENT_ID, { voucher: 'NAOEXISTE' }), 'VOUCHER_NOT_FOUND');
  });

  it('C2. voucher de OUTRO evento → 422 VOUCHER_NOT_FOUND', async () => {
    client.voucher.findUnique.mockResolvedValue({
      eventId: 'outro-evento', status: 'ACTIVE', expiryDate: null, deletedAt: null,
    });
    await expect422(service.findAll(EVENT_ID, { voucher: 'ABC' }), 'VOUCHER_NOT_FOUND');
  });

  it('C3. voucher soft-deleted → 422 VOUCHER_NOT_FOUND', async () => {
    client.voucher.findUnique.mockResolvedValue({
      eventId: EVENT_ID, status: 'ACTIVE', expiryDate: null, deletedAt: new Date(),
    });
    await expect422(service.findAll(EVENT_ID, { voucher: 'ABC' }), 'VOUCHER_NOT_FOUND');
  });

  it('C4. voucher INACTIVE → 422 VOUCHER_NOT_FOUND (sem vazar detalhe interno)', async () => {
    client.voucher.findUnique.mockResolvedValue({
      eventId: EVENT_ID, status: 'INACTIVE', expiryDate: null, deletedAt: null,
    });
    await expect422(service.findAll(EVENT_ID, { voucher: 'ABC' }), 'VOUCHER_NOT_FOUND');
  });

  // ── D. Voucher válido ──────────────────────────────────────────────────────
  it('D1. voucher ACTIVE e válido → lista produtos normalmente', async () => {
    client.voucher.findUnique.mockResolvedValue({
      eventId: EVENT_ID, status: 'ACTIVE', expiryDate: null, deletedAt: null,
    });

    const res = await service.findAll(EVENT_ID, { voucher: 'fvfj0mao' });

    expect(res.message).toBe('Products fetched successfully');
    expect(client.product.findMany).toHaveBeenCalled();
    // Código é normalizado (uppercase + trim) antes do lookup — igual ao patchCoupon.
    expect(client.voucher.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: 'FVFJ0MAO' } }),
    );
  });

  it('D2. voucher ACTIVE reservado por outro pedido NÃO barra a listagem', async () => {
    // A exclusividade da reserva é decidida na aplicação (patchCoupon/pay), não aqui.
    client.voucher.findUnique.mockResolvedValue({
      eventId: EVENT_ID, status: 'ACTIVE', expiryDate: null, deletedAt: null,
      reservedByOrderId: 'pedido-de-outra-pessoa', reservedUntil: new Date(Date.now() + 600_000),
    });

    const res = await service.findAll(EVENT_ID, { voucher: 'ABC' });
    expect(res.message).toBe('Products fetched successfully');
  });

  // ── E. Sem voucher ─────────────────────────────────────────────────────────
  it('E. sem voucher na query → não consulta a tabela de voucher', async () => {
    await service.findAll(EVENT_ID, { page: 1, limit: 10 });
    expect(client.voucher.findUnique).not.toHaveBeenCalled();
    expect(client.product.findMany).toHaveBeenCalled();
  });
});
