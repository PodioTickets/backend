/**
 * ROTEIRO — previewByCode (GET /coupons/events/:eventId/preview)
 * ==============================================================
 * Preview público do link de checkout. SEMPRE 200 `{ data: preview | null }`, nunca lança.
 *  - kind discrimina coupon vs voucher
 *  - AGE não entra (endpoint próprio)
 *  - preview é só exibição: NÃO rejeita por CPF/uso/mínimo
 *  - inexistente/expirado/inativo/voucher-usado/sem-code → null
 *  - voucher tem prioridade sobre cupom de mesmo código
 */
import { Test, TestingModule } from '@nestjs/testing';
import { CouponsService } from '../coupons.service';
import { PrismaService } from '../../../prisma/prisma.service';

describe('CouponsService.previewByCode', () => {
  let service: CouponsService;
  let client: any;
  const mockPrisma = { getReadClient: jest.fn(), getWriteClient: jest.fn() };

  const setup = ({ event = { id: 'evt-1' }, coupon = null, voucher = null }: any) => {
    client = {
      event: { findUnique: jest.fn().mockResolvedValue(event) },
      coupon: { findUnique: jest.fn().mockResolvedValue(coupon) },
      voucher: { findUnique: jest.fn().mockResolvedValue(voucher) },
    };
    mockPrisma.getReadClient.mockReturnValue(client);
  };

  const future = new Date('2099-01-01');
  const past = new Date('2000-01-01');
  const baseCoupon = (over: any = {}) => ({
    code: 'OFF50', value: 50, type: 'PERCENTAGE', couponType: 'DISCOUNT',
    applyToProducts: false, status: 'ACTIVE', expiryDate: null, deletedAt: null, ...over,
  });
  const baseVoucher = (over: any = {}) => ({
    code: 'CORTESIA', appliesTo: '["t1","t2"]', status: 'ACTIVE',
    expiryDate: null, usedAt: null, deletedAt: null, ...over,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CouponsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<CouponsService>(CouponsService);
  });
  afterEach(() => jest.clearAllMocks());

  it('CUPOM DISCOUNT → kind=coupon com couponType/type/value/applyToProducts', async () => {
    setup({ coupon: baseCoupon() });
    const res = await service.previewByCode('evt-1', 'off50');
    expect(res.data).toEqual({
      kind: 'coupon', code: 'OFF50', couponType: 'DISCOUNT', type: 'PERCENTAGE', value: 50, applyToProducts: false,
    });
  });

  it('CUPOM QUANTITY → também previewável (kind=coupon)', async () => {
    setup({ coupon: baseCoupon({ couponType: 'QUANTITY', type: 'FIXED', value: 1000 }) });
    const res: any = await service.previewByCode('evt-1', 'OFF50');
    expect(res.data.kind).toBe('coupon');
    expect(res.data.couponType).toBe('QUANTITY');
    expect(res.data.value).toBe(1000);
  });

  it('CUPOM AGE → NÃO entra no preview do link → data null', async () => {
    setup({ coupon: baseCoupon({ couponType: 'AGE' }) });
    const res = await service.previewByCode('evt-1', 'OFF50');
    expect(res.data).toBeNull();
  });

  it('VOUCHER usável → kind=voucher + appliesTo normalizado em array', async () => {
    setup({ voucher: baseVoucher() });
    const res: any = await service.previewByCode('evt-1', 'cortesia');
    expect(res.data.kind).toBe('voucher');
    expect(res.data.code).toBe('CORTESIA');
    expect(res.data.appliesTo).toEqual(['t1', 't2']);
  });

  it('VOUCHER appliesTo "all" → mantém "all"', async () => {
    setup({ voucher: baseVoucher({ appliesTo: 'all' }) });
    const res: any = await service.previewByCode('evt-1', 'CORTESIA');
    expect(res.data.appliesTo).toBe('all');
  });

  it('VOUCHER tem prioridade sobre cupom de mesmo código', async () => {
    setup({ coupon: baseCoupon(), voucher: baseVoucher() });
    const res: any = await service.previewByCode('evt-1', 'X');
    expect(res.data.kind).toBe('voucher');
  });

  it('preview NÃO rejeita por restrição de CPF / uso / mínimo (só exibição)', async () => {
    // cupom com cpfList, maxUsage atingido e minCartValue alto — ainda assim deve exibir
    setup({ coupon: baseCoupon({ cpfListStatus: 'ENABLED', maxUsage: 1, usageCount: 5, minCartValue: 999999 }) });
    const res: any = await service.previewByCode('evt-1', 'OFF50');
    expect(res.data.kind).toBe('coupon');
  });

  it('código inexistente → data null (HTTP 200, não 404)', async () => {
    setup({ coupon: null, voucher: null });
    const res = await service.previewByCode('evt-1', 'NOPE');
    expect(res.data).toBeNull();
  });

  it('cupom expirado (data) → null', async () => {
    setup({ coupon: baseCoupon({ expiryDate: past }) });
    expect((await service.previewByCode('evt-1', 'OFF50')).data).toBeNull();
  });

  it('cupom expirado/inativo (status) → null', async () => {
    setup({ coupon: baseCoupon({ status: 'INACTIVE' }) });
    expect((await service.previewByCode('evt-1', 'OFF50')).data).toBeNull();
  });

  it('cupom soft-deleted → null', async () => {
    setup({ coupon: baseCoupon({ deletedAt: new Date() }) });
    expect((await service.previewByCode('evt-1', 'OFF50')).data).toBeNull();
  });

  it('voucher já utilizado → null (não exibe)', async () => {
    setup({ voucher: baseVoucher({ usedAt: new Date(), status: 'USED' }) });
    expect((await service.previewByCode('evt-1', 'CORTESIA')).data).toBeNull();
  });

  it('voucher expirado (data futura ok / passada → null)', async () => {
    setup({ voucher: baseVoucher({ expiryDate: past }) });
    expect((await service.previewByCode('evt-1', 'CORTESIA')).data).toBeNull();
    setup({ voucher: baseVoucher({ expiryDate: future }) });
    expect((await service.previewByCode('evt-1', 'CORTESIA')).data).not.toBeNull();
  });

  it('sem code → null (não dispara lookup)', async () => {
    setup({});
    const res = await service.previewByCode('evt-1', undefined);
    expect(res.data).toBeNull();
    expect(client.coupon.findUnique).not.toHaveBeenCalled();
  });

  it('evento inexistente → null', async () => {
    setup({ event: null, coupon: baseCoupon() });
    expect((await service.previewByCode('evt-1', 'OFF50')).data).toBeNull();
  });
});
