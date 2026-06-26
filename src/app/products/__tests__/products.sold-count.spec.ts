import { Test, TestingModule } from '@nestjs/testing';
import { ProductsService } from '../products.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrganizationsService } from '../../organizations/organizations.service';
import { UploadService } from '../../upload/upload.service';

/**
 * "Total vendidos" das variações = contagem REAL de RegistrationProduct (não o `soldCount`
 * denormalizado, que estorno decrementa e que nunca somou vendas do finalize legado).
 */
describe('ProductsService.overrideVariationSoldCounts', () => {
  let service: ProductsService;
  const mockPrisma = { getReadClient: jest.fn(), getWriteClient: jest.fn() };

  beforeEach(async () => {
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

  it('sobrescreve soldCount com SUM(quantity) do RegistrationProduct; variação sem venda → 0', async () => {
    const prismaRead: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ variationId: 'v1', sold: BigInt(7) }]),
    };
    // soldCount denormalizado vem "errado" (3 e 5); deve ser substituído pela contagem real.
    const products = [
      { variations: [{ id: 'v1', soldCount: 3 }, { id: 'v2', soldCount: 5 }] },
    ];

    await (service as any).overrideVariationSoldCounts(prismaRead, products);

    expect(products[0].variations[0].soldCount).toBe(7); // real
    expect(products[0].variations[1].soldCount).toBe(0); // sem RegistrationProduct → 0
  });

  it('sem variações → não consulta o banco (early return)', async () => {
    const prismaRead: any = { $queryRaw: jest.fn() };
    await (service as any).overrideVariationSoldCounts(prismaRead, [{ variations: [] }]);
    expect(prismaRead.$queryRaw).not.toHaveBeenCalled();
  });
});
