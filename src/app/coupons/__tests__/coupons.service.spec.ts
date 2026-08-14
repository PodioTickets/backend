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
import { OrganizationAuditService } from '../../../common/services/organization-audit.service';

describe('CouponsService.previewByCode', () => {
  let service: CouponsService;
  let client: any;
  const mockPrisma = { getReadClient: jest.fn(), getWriteClient: jest.fn() };

  const setup = ({ event = { id: 'evt-1' }, coupon = null, voucher = null, reserved = 0 }: any) => {
    client = {
      event: { findUnique: jest.fn().mockResolvedValue(event) },
      coupon: { findUnique: jest.fn().mockResolvedValue(coupon) },
      voucher: { findUnique: jest.fn().mockResolvedValue(voucher) },
    };
    mockPrisma.getReadClient.mockReturnValue(client);
    // getWriteClient é usado SÓ para somar as reservas ATIVAS do cupom (pedidos
    // PENDING não-expirados). `reserved` controla o total reservado no cenário.
    mockPrisma.getWriteClient.mockReturnValue({
      $queryRaw: jest.fn().mockResolvedValue([{ reserved }]),
    });
  };

  const future = new Date('2099-01-01');
  const past = new Date('2000-01-01');
  const baseCoupon = (over: any = {}) => ({
    id: 'cpn-1', code: 'OFF50', value: 50, type: 'PERCENTAGE', couponType: 'DISCOUNT',
    applyToProducts: false, appliesTo: 'all', minCartValue: null, minQuantity: null,
    status: 'ACTIVE', expiryDate: null, deletedAt: null, ...over,
  });
  const baseVoucher = (over: any = {}) => ({
    code: 'CORTESIA', appliesTo: '["t1","t2"]', status: 'ACTIVE',
    expiryDate: null, usedAt: null, deletedAt: null,
    reservedByOrderId: null, reservedUntil: null, ...over,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CouponsService, { provide: PrismaService, useValue: mockPrisma }, { provide: OrganizationAuditService, useValue: { record: jest.fn(), recordForEvent: jest.fn() } }],
    }).compile();
    service = module.get<CouponsService>(CouponsService);
  });
  afterEach(() => jest.clearAllMocks());

  it('CUPOM DISCOUNT → kind=coupon com couponType/type/value/applyToProducts + escopo/condições', async () => {
    setup({ coupon: baseCoupon() });
    const res = await service.previewByCode('evt-1', 'off50');
    expect(res.data).toEqual({
      kind: 'coupon', code: 'OFF50', couponType: 'DISCOUNT', type: 'PERCENTAGE', value: 50,
      applyToProducts: false, appliesTo: 'all', minCartValue: null, minQuantity: null,
      remaining: null, // sem maxUsage → sem limite (o interceptor remove null no response real)
    });
  });

  it('CUPOM com appliesTo (lista) + condições → retorna ingressos cobertos + minCartValue/minQuantity', async () => {
    setup({ coupon: baseCoupon({ appliesTo: '["tk-A","tk-B"]', minCartValue: 5000, minQuantity: 2 }) });
    const res: any = await service.previewByCode('evt-1', 'OFF50');
    expect(res.data.appliesTo).toEqual(['tk-A', 'tk-B']); // normalizado de JSON string → array
    expect(res.data.minCartValue).toBe(5000);
    expect(res.data.minQuantity).toBe(2);
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

  it('preview NÃO rejeita por restrição de CPF / mínimo (só exibição)', async () => {
    // cupom com cpfList e minCartValue alto, mas com uso disponível → ainda deve exibir
    setup({ coupon: baseCoupon({ cpfListStatus: 'ENABLED', maxUsage: 10, usageCount: 5, minCartValue: 999999 }) });
    const res: any = await service.previewByCode('evt-1', 'OFF50');
    expect(res.data.kind).toBe('coupon');
  });

  it('cupom ESGOTADO (usageCount >= maxUsage) → null (espelha COUPON_EXHAUSTED do apply)', async () => {
    setup({ coupon: baseCoupon({ maxUsage: 1, usageCount: 5 }) });
    expect((await service.previewByCode('evt-1', 'OFF50')).data).toBeNull();
  });

  it('cupom no limite exato (usageCount == maxUsage) → null (esgotado)', async () => {
    setup({ coupon: baseCoupon({ maxUsage: 3, usageCount: 3 }) });
    expect((await service.previewByCode('evt-1', 'OFF50')).data).toBeNull();
  });

  it('cupom com uso ainda disponível (usageCount < maxUsage) → exibe', async () => {
    setup({ coupon: baseCoupon({ maxUsage: 3, usageCount: 2 }) });
    expect((await service.previewByCode('evt-1', 'OFF50')).data).not.toBeNull();
  });

  it('cupom sem limite (maxUsage null) → exibe independente do usageCount', async () => {
    setup({ coupon: baseCoupon({ maxUsage: null, usageCount: 999 }) });
    expect((await service.previewByCode('evt-1', 'OFF50')).data).not.toBeNull();
  });

  it('DISCOUNT com maxUsage → expõe remaining (maxUsage − usageCount)', async () => {
    setup({ coupon: baseCoupon({ couponType: 'DISCOUNT', maxUsage: 5, usageCount: 3 }) });
    const res: any = await service.previewByCode('evt-1', 'OFF50');
    expect(res.data.remaining).toBe(2);
  });

  it('DISCOUNT sem maxUsage → remaining null (sem limite)', async () => {
    setup({ coupon: baseCoupon({ couponType: 'DISCOUNT', maxUsage: null, usageCount: 9 }) });
    const res: any = await service.previewByCode('evt-1', 'OFF50');
    expect(res.data.remaining).toBeNull();
  });

  it('QUANTITY com maxUsage → remaining null (all-or-nothing por pedido, não por unidade)', async () => {
    setup({ coupon: baseCoupon({ couponType: 'QUANTITY', maxUsage: 5, usageCount: 1, minQuantity: 2 }) });
    const res: any = await service.previewByCode('evt-1', 'OFF50');
    expect(res.data.remaining).toBeNull();
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

  // ── Reservas ATIVAS contam no limite (vendas + reservas) ──────────────────
  describe('limite considerando reservas ativas', () => {
    it('limite 10, 9 vendidos + 1 RESERVADO → 10/10 esgotado → null', async () => {
      setup({ coupon: baseCoupon({ maxUsage: 10, usageCount: 9 }), reserved: 1 });
      expect((await service.previewByCode('evt-1', 'OFF50')).data).toBeNull();
    });

    it('limite 10, 9 vendidos + 0 reservados (reserva liberada/expirou) → exibe, remaining 1', async () => {
      setup({ coupon: baseCoupon({ couponType: 'DISCOUNT', maxUsage: 10, usageCount: 9 }), reserved: 0 });
      const res: any = await service.previewByCode('evt-1', 'OFF50');
      expect(res.data).not.toBeNull();
      expect(res.data.remaining).toBe(1);
    });

    it('remaining desconta as reservas: max 10, 5 vendidos, 2 reservados → remaining 3', async () => {
      setup({ coupon: baseCoupon({ couponType: 'DISCOUNT', maxUsage: 10, usageCount: 5 }), reserved: 2 });
      const res: any = await service.previewByCode('evt-1', 'OFF50');
      expect(res.data.remaining).toBe(3);
    });

    it('sem maxUsage → não consulta reservas e exibe (sem limite)', async () => {
      setup({ coupon: baseCoupon({ maxUsage: null, usageCount: 999 }), reserved: 5 });
      expect((await service.previewByCode('evt-1', 'OFF50')).data).not.toBeNull();
      expect(mockPrisma.getWriteClient().$queryRaw).not.toHaveBeenCalled();
    });
  });

  // ── Voucher reservado por pedido ativo some do preview ────────────────────
  describe('voucher reservado', () => {
    it('reservado por pedido ATIVO (reservedUntil futuro) → null', async () => {
      setup({ voucher: baseVoucher({ reservedByOrderId: 'ord-1', reservedUntil: future }) });
      expect((await service.previewByCode('evt-1', 'CORTESIA')).data).toBeNull();
    });

    it('reserva EXPIRADA (reservedUntil passado) → exibe (carrinho abandonado liberado)', async () => {
      setup({ voucher: baseVoucher({ reservedByOrderId: 'ord-1', reservedUntil: past }) });
      expect((await service.previewByCode('evt-1', 'CORTESIA')).data).not.toBeNull();
    });

    it('sem reserva (reservedByOrderId null) → exibe', async () => {
      setup({ voucher: baseVoucher() });
      expect((await service.previewByCode('evt-1', 'CORTESIA')).data).not.toBeNull();
    });
  });

  // ── AGE eligibility: esgotamento também conta reservas ativas ─────────────
  describe('getApplicableAgeCoupons (limite com reservas)', () => {
    // Nascido em 2009-06-15 → 20 anos na data do evento (2030-01-01).
    const dob20 = new Date('2009-06-15');
    const ageCoupon = (over: any = {}) => ({
      id: 'age-1', code: 'JOVEM', couponType: 'AGE', type: 'PERCENTAGE', value: 20,
      ageRule: null, ageValue: null, minAge: 18, maxAge: 25, appliesTo: 'all',
      applyToProducts: false, minCartValue: null, note: null,
      usageCount: 9, maxUsage: 10, ...over,
    });
    const setupAge = ({ coupons = [] as any[], reserved = 0 }: any) => {
      mockPrisma.getReadClient.mockReturnValue({
        event: { findUnique: jest.fn().mockResolvedValue({ id: 'evt-1', eventDate: new Date('2030-01-01') }) },
        coupon: { findMany: jest.fn().mockResolvedValue(coupons) },
      });
      mockPrisma.getWriteClient.mockReturnValue({
        $queryRaw: jest.fn().mockResolvedValue([{ reserved }]),
      });
    };

    it('9 vendidos + 1 RESERVADO → 10/10 esgotado → NÃO aplicável', async () => {
      setupAge({ coupons: [ageCoupon({ usageCount: 9, maxUsage: 10 })], reserved: 1 });
      const res: any = await service.getApplicableAgeCoupons('evt-1', { dateOfBirth: dob20 });
      expect(res.data.applicable).toBe(false);
    });

    it('9 vendidos + 0 reservados (reserva liberada) → aplicável', async () => {
      setupAge({ coupons: [ageCoupon({ usageCount: 9, maxUsage: 10 })], reserved: 0 });
      const res: any = await service.getApplicableAgeCoupons('evt-1', { dateOfBirth: dob20 });
      expect(res.data.applicable).toBe(true);
    });

    it('sem maxUsage → aplicável sem consultar reservas', async () => {
      setupAge({ coupons: [ageCoupon({ maxUsage: null, usageCount: 999 })], reserved: 7 });
      const res: any = await service.getApplicableAgeCoupons('evt-1', { dateOfBirth: dob20 });
      expect(res.data.applicable).toBe(true);
      expect(mockPrisma.getWriteClient().$queryRaw).not.toHaveBeenCalled();
    });

    // ── Lista exclusiva de documento (idade E lista) ───────────────────────
    it('lista ENABLED + CPF do comprador NA lista → aplicável', async () => {
      setupAge({
        coupons: [ageCoupon({ maxUsage: null, cpfListStatus: 'ENABLED', cpfList: ['11111111111'], documentList: null })],
        reserved: 0,
      });
      const res: any = await service.getApplicableAgeCoupons('evt-1', {
        dateOfBirth: dob20, documentType: 'CPF', documentNumber: '111.111.111-11',
      });
      expect(res.data.applicable).toBe(true);
    });

    it('lista ENABLED + CPF do comprador FORA da lista → NÃO aplicável (mesmo na faixa)', async () => {
      setupAge({
        coupons: [ageCoupon({ maxUsage: null, cpfListStatus: 'ENABLED', cpfList: ['11111111111'], documentList: null })],
        reserved: 0,
      });
      const res: any = await service.getApplicableAgeCoupons('evt-1', {
        dateOfBirth: dob20, documentType: 'CPF', documentNumber: '99999999999',
      });
      expect(res.data.applicable).toBe(false);
      expect(res.data.appliedCoupon).toBeNull();
    });

    it('lista ENABLED + comprador SEM documento → NÃO aplicável (segurança)', async () => {
      setupAge({
        coupons: [ageCoupon({ maxUsage: null, cpfListStatus: 'ENABLED', cpfList: ['11111111111'], documentList: null })],
        reserved: 0,
      });
      const res: any = await service.getApplicableAgeCoupons('evt-1', { dateOfBirth: dob20 });
      expect(res.data.applicable).toBe(false);
    });

    it('lista DISABLED → aplicável independente do documento (lista ignorada)', async () => {
      setupAge({
        coupons: [ageCoupon({ maxUsage: null, cpfListStatus: 'DISABLED', cpfList: ['11111111111'] })],
        reserved: 0,
      });
      const res: any = await service.getApplicableAgeCoupons('evt-1', {
        dateOfBirth: dob20, documentType: 'CPF', documentNumber: '99999999999',
      });
      expect(res.data.applicable).toBe(true);
    });
  });

  // ── findAll: status EFETIVO por validade (lista organizador/admin) ─────────
  describe('findAll (status efetivo por validade)', () => {
    const setupList = (coupons: any[]) => {
      mockPrisma.getReadClient.mockReturnValue({
        coupon: {
          findMany: jest.fn().mockResolvedValue(coupons),
          count: jest.fn().mockResolvedValue(coupons.length),
        },
      });
    };
    const listCoupon = (over: any = {}) => ({
      id: 'c1', code: 'X', status: 'ACTIVE', expiryDate: null, appliesTo: 'all', ...over,
    });

    it('ATIVO com validade VENCIDA → EXPIRED', async () => {
      setupList([listCoupon({ status: 'ACTIVE', expiryDate: past })]);
      const res: any = await service.findAll('evt-1');
      expect(res.data.coupons[0].status).toBe('EXPIRED');
    });

    it('ATIVO com validade FUTURA → ATIVO', async () => {
      setupList([listCoupon({ status: 'ACTIVE', expiryDate: future })]);
      const res: any = await service.findAll('evt-1');
      expect(res.data.coupons[0].status).toBe('ACTIVE');
    });

    it('ATIVO sem validade → ATIVO', async () => {
      setupList([listCoupon({ status: 'ACTIVE', expiryDate: null })]);
      const res: any = await service.findAll('evt-1');
      expect(res.data.coupons[0].status).toBe('ACTIVE');
    });

    it('INACTIVE vencido → preserva INACTIVE (desligado manual, não vira EXPIRED)', async () => {
      setupList([listCoupon({ status: 'INACTIVE', expiryDate: past })]);
      const res: any = await service.findAll('evt-1');
      expect(res.data.coupons[0].status).toBe('INACTIVE');
    });

    it('já EXPIRED → permanece EXPIRED', async () => {
      setupList([listCoupon({ status: 'EXPIRED', expiryDate: past })]);
      const res: any = await service.findAll('evt-1');
      expect(res.data.coupons[0].status).toBe('EXPIRED');
    });

    // ── Filtro ?status= considera a validade EFETIVA (where consistente) ──────
    const captureWhere = async (status: string) => {
      const findMany = jest.fn().mockResolvedValue([]);
      mockPrisma.getReadClient.mockReturnValue({
        coupon: { findMany, count: jest.fn().mockResolvedValue(0) },
      });
      await service.findAll('evt-1', { status } as any);
      return findMany.mock.calls[0][0].where;
    };

    it('filtro ACTIVE → status ACTIVE E não vencido (exclui ATIVO vencido)', async () => {
      const where = await captureWhere('ACTIVE');
      expect(where.status).toBe('ACTIVE');
      expect(where.OR).toEqual([
        { expiryDate: null },
        { expiryDate: { gte: expect.any(Date) } },
      ]);
    });

    it('filtro EXPIRED → EXPIRED no banco OU ATIVO vencido (inclui ATIVO vencido)', async () => {
      const where = await captureWhere('EXPIRED');
      expect(where.status).toBeUndefined();
      expect(where.OR).toEqual([
        { status: 'EXPIRED' },
        { status: 'ACTIVE', expiryDate: { lt: expect.any(Date) } },
      ]);
    });

    it('filtro INACTIVE → status cru (sem condição de data)', async () => {
      const where = await captureWhere('INACTIVE');
      expect(where.status).toBe('INACTIVE');
      expect(where.OR).toBeUndefined();
    });
  });
});
