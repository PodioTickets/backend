/**
 * ROTEIRO — sortOrder das variações de produto
 * =============================================
 * Garante que a ordem do array recebido é persistida como `sortOrder` (índice 0,1,2…) no
 * create E recomputada no update (permite reordenar). Fix do bug "P,M,G voltava G,M,P".
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ProductsService } from '../products.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrganizationsService } from '../../organizations/organizations.service';
import { UploadService } from '../../upload/upload.service';

describe('ProductsService — sortOrder das variações', () => {
  let service: ProductsService;
  let client: any;

  const mockPrisma = { getReadClient: jest.fn(), getWriteClient: jest.fn() };

  beforeEach(async () => {
    client = {
      // role ADMIN → verifyOrganizerAccess dá bypass nas checagens de organização
      user: { findUnique: jest.fn().mockResolvedValue({ role: 'ADMIN' }) },
      event: { findUnique: jest.fn().mockResolvedValue({ organizationId: 'org-1', name: 'Evento' }) },
      product: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'p1', name: 'Camiseta', image: null, images: [], variations: [] }),
      },
      productVariation: { update: jest.fn().mockResolvedValue({}), create: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      registrationProduct: { findMany: jest.fn().mockResolvedValue([]) },
    };
    mockPrisma.getReadClient.mockReturnValue(client);
    mockPrisma.getWriteClient.mockReturnValue(client);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrganizationsService, useValue: { recordOrganizationAuditLog: jest.fn().mockResolvedValue(undefined) } },
        { provide: UploadService, useValue: {} },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('CREATE: grava sortOrder pela ordem do array (P=0, M=1, G=2)', async () => {
    let captured: any;
    client.product.create.mockImplementation(({ data }: any) => {
      captured = data;
      return { id: 'p1', name: data.name, image: null, images: [], variations: [] };
    });

    await service.create('admin-1', 'evt-1', {
      name: 'Camiseta',
      isRequired: true, // evita prepend da variação "Sem interesse"
      variations: [
        { name: 'P', price: 0, stock: 10 },
        { name: 'M', price: 0, stock: 10 },
        { name: 'G', price: 0, stock: 10 },
      ],
    } as any);

    expect(captured.variations.create).toEqual([
      expect.objectContaining({ name: 'P', sortOrder: 0 }),
      expect.objectContaining({ name: 'M', sortOrder: 1 }),
      expect.objectContaining({ name: 'G', sortOrder: 2 }),
    ]);
  });

  it('CREATE: availableStock parte igual ao stock (limite) — nada vendido ainda', async () => {
    let captured: any;
    client.product.create.mockImplementation(({ data }: any) => {
      captured = data;
      return { id: 'p1', name: data.name, image: null, images: [], variations: [] };
    });

    await service.create('admin-1', 'evt-1', {
      name: 'Camiseta',
      isRequired: true,
      variations: [
        { name: 'P', price: 0, stock: 10 },
        { name: 'Ilimitada', price: 0, stock: 0 },
      ],
    } as any);

    expect(captured.variations.create).toEqual([
      expect.objectContaining({ name: 'P', stock: 10, availableStock: 10 }),
      expect.objectContaining({ name: 'Ilimitada', stock: 0, availableStock: 0 }),
    ]);
  });

  it('UPDATE: ajusta availableStock pelo DELTA do limite (preserva vendas/holds)', async () => {
    // v-a: limite 10→15 com 4 já fora (restante 6) → restante 11.
    // v-b: limite 10→8  com 3 já fora (restante 7) → restante 5.
    // v-c: limite 10→10 (restante 2) → restante 2 (inalterado).
    client.product.findUnique.mockResolvedValue({
      id: 'p1', eventId: 'evt-1', isRequired: true, tickets: [],
      variations: [
        { id: 'v-a', name: 'A', price: 0, stock: 10, availableStock: 6 },
        { id: 'v-b', name: 'B', price: 0, stock: 10, availableStock: 7 },
        { id: 'v-c', name: 'C', price: 0, stock: 10, availableStock: 2 },
      ],
    });

    await service.update('admin-1', 'evt-1', 'p1', {
      variations: [
        { id: 'v-a', name: 'A', price: 0, stock: 15 },
        { id: 'v-b', name: 'B', price: 0, stock: 8 },
        { id: 'v-c', name: 'C', price: 0, stock: 10 },
      ],
    } as any);

    const availableById: Record<string, number> = {};
    for (const callArgs of client.productVariation.update.mock.calls) {
      availableById[callArgs[0].where.id] = callArgs[0].data.availableStock;
    }
    expect(availableById).toEqual({ 'v-a': 11, 'v-b': 5, 'v-c': 2 });
  });

  it('UPDATE: recomputa sortOrder pela NOVA ordem do array (reordenar G,P,M)', async () => {
    client.product.findUnique.mockResolvedValue({
      id: 'p1', eventId: 'evt-1', isRequired: true, tickets: [],
      variations: [
        { id: 'v-p', name: 'P', price: 0, stock: 10 },
        { id: 'v-m', name: 'M', price: 0, stock: 10 },
        { id: 'v-g', name: 'G', price: 0, stock: 10 },
      ],
    });

    await service.update('admin-1', 'evt-1', 'p1', {
      variations: [
        { id: 'v-g', name: 'G', price: 0, stock: 10 }, // sortOrder 0
        { id: 'v-p', name: 'P', price: 0, stock: 10 }, // sortOrder 1
        { id: 'v-m', name: 'M', price: 0, stock: 10 }, // sortOrder 2
      ],
    } as any);

    const sortOrderById: Record<string, number> = {};
    for (const callArgs of client.productVariation.update.mock.calls) {
      sortOrderById[callArgs[0].where.id] = callArgs[0].data.sortOrder;
    }
    expect(sortOrderById).toEqual({ 'v-g': 0, 'v-p': 1, 'v-m': 2 });
  });
});
