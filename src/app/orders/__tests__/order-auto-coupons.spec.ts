/**
 * Cupons automáticos no mesmo pedido: só competem os que cobrem o mesmo ingresso.
 * Cupons de ingressos diferentes valem juntos, cada um descontando do próprio ingresso.
 */
import { autoCouponScopeWithManual, selectAutoCoupons, sumUnitDiscounts, ticketIdsOfSlots } from '../order-discount.util';
import { orderShape } from '../orders.service';

const cand = (id: string, discount: number, coveredTicketIds: string[]) => ({
  coupon: { id }, discount, coveredTicketIds,
});
const ids = (list: Array<{ coupon: { id: string } }>) => list.map((c) => c.coupon.id);

describe('selectAutoCoupons', () => {
  it('cupons de ingressos diferentes valem juntos, maior desconto primeiro', () => {
    expect(ids(selectAutoCoupons([cand('a', 1000, ['t1']), cand('b', 2000, ['t2'])]))).toEqual(['b', 'a']);
  });

  it('três ingressos, três cupons: todos valem', () => {
    const r = selectAutoCoupons([cand('a', 10, ['t1']), cand('b', 20, ['t2']), cand('c', 30, ['t3'])]);
    expect(ids(r)).toEqual(['c', 'b', 'a']);
  });

  it('dois cupons no mesmo ingresso competem: vale o que mais desconta', () => {
    expect(ids(selectAutoCoupons([cand('a', 10, ['t1']), cand('b', 20, ['t1'])]))).toEqual(['b']);
  });

  it('cobertura parcial: o maior fica com os ingressos dele e tira os concorrentes', () => {
    const r = selectAutoCoupons([cand('x', 10000, ['a', 'b']), cand('y', 6000, ['a']), cand('z', 6000, ['b'])]);
    expect(ids(r)).toEqual(['x']);
  });

  it('cupom sem restrição de ingresso compete com todos', () => {
    const r = selectAutoCoupons([cand('todos', 5000, ['t1', 't2']), cand('a', 1000, ['t1']), cand('b', 1000, ['t2'])]);
    expect(ids(r)).toEqual(['todos']);
  });

  it('empate no mesmo ingresso: mantém o já aplicado no pedido', () => {
    expect(ids(selectAutoCoupons([cand('a', 10, ['t1']), cand('b', 10, ['t1'])], 'b'))).toEqual(['b']);
  });

  it('nenhum candidato → lista vazia', () => {
    expect(selectAutoCoupons([])).toEqual([]);
  });
});

describe('autoCouponScopeWithManual', () => {
  const order = ['t1', 't2', 't2'];
  const scope = (coupon: any, manual: string | null) => autoCouponScopeWithManual(coupon, manual, order)?.appliesTo;

  it('manual em todos os ingressos tira a quantidade sem "Acumular descontos"', () => {
    expect(autoCouponScopeWithManual({ couponType: 'QUANTITY', allowStacking: false }, 'all', order)).toBeNull();
    expect(autoCouponScopeWithManual({ couponType: 'QUANTITY' }, null, order)).toBeNull();
  });

  it('com "Acumular descontos" o automático fica inteiro', () => {
    const c = { couponType: 'QUANTITY', allowStacking: true, appliesTo: 'all' };
    expect(autoCouponScopeWithManual(c, '["t1"]', order)).toBe(c);
  });

  it('automático em ingresso que o manual não cobre fica igual', () => {
    const c = { couponType: 'QUANTITY', appliesTo: '["t1"]' };
    expect(autoCouponScopeWithManual(c, '["t2"]', order)).toBe(c);
  });

  it('automático da categoria perde só o ingresso do manual (2026-11-11)', () => {
    expect(scope({ couponType: 'QUANTITY', appliesTo: '["t1","t2"]' }, '["t2"]')).toBe('["t1"]');
    expect(scope({ couponType: 'QUANTITY', appliesTo: 'all' }, '["t2"]')).toBe('["t1"]');
    expect(scope({ couponType: 'QUANTITY', appliesTo: null }, '["t1"]')).toBe('["t2"]');
  });

  it('manual tira o automático da categoria inteira (2026-11-13)', () => {
    // t1/t2 = categoria "corrida"; t3 = "kids"; t4 sem categoria.
    const tickets = [
      { id: 't1', categoryId: 'corrida' },
      { id: 't2', categoryId: 'corrida' },
      { id: 't3', categoryId: 'kids' },
      { id: 't4', categoryId: null },
    ];
    const cart = ['t1', 't2', 't3', 't4'];
    const scoped = (appliesTo: string | null, manual: string) =>
      autoCouponScopeWithManual({ couponType: 'QUANTITY', appliesTo }, manual, cart, tickets)?.appliesTo ?? null;
    expect(scoped('all', '["t1"]')).toBe('["t3","t4"]');
    expect(scoped('["t2","t3"]', '["t1"]')).toBe('["t3"]');
    expect(scoped('["t2"]', '["t1"]')).toBeNull();
    // Sem categoria: só o próprio ingresso.
    expect(scoped('all', '["t4"]')).toBe('["t1","t2","t3"]');
    // Manual fora do carrinho ainda bloqueia a categoria dele.
    expect(autoCouponScopeWithManual({ couponType: 'QUANTITY', appliesTo: 'all' }, '["t1"]', ['t2', 't3'], tickets)?.appliesTo).toBe('["t3"]');
  });

  it('sem ingresso sobrando o automático sai', () => {
    expect(autoCouponScopeWithManual({ couponType: 'QUANTITY', appliesTo: '["t2"]' }, '["t2","t3"]', order)).toBeNull();
  });

  it('idade (legado) segue acumulando inteira', () => {
    const c = { couponType: 'AGE', allowStacking: false };
    expect(autoCouponScopeWithManual(c, 'all', order)).toBe(c);
  });
});

describe('ticketIdsOfSlots', () => {
  const reserved = [{ ticketId: 't1', quantity: 2 }, { ticketId: 't2', quantity: 2 }];

  it('cupom de idade ocupa só o ingresso dos participantes elegíveis', () => {
    expect(ticketIdsOfSlots(reserved, [0, 1])).toEqual(['t1']);
    expect(ticketIdsOfSlots(reserved, [1, 2])).toEqual(['t1', 't2']);
  });

  it('ignora posição fora dos ingressos reservados', () => {
    expect(ticketIdsOfSlots(reserved, [9])).toEqual([]);
  });
});

describe('sumUnitDiscounts', () => {
  it('soma ingresso e produtos por unidade', () => {
    const r = sumUnitDiscounts([
      [{ ticketId: 't1', unitDiscount: 100, productsDiscount: 10 }, { ticketId: 't2', unitDiscount: 0, productsDiscount: 0 }],
      [{ ticketId: 't1', unitDiscount: 0, productsDiscount: 0 }, { ticketId: 't2', unitDiscount: 200, productsDiscount: 20 }],
    ]);
    expect(r.map((u) => [u.unitDiscount, u.productsDiscount])).toEqual([[100, 10], [200, 20]]);
  });
});

describe('orderShape com cupons extras', () => {
  // 2 unidades do 5km (R$ 100) e 2 do 10km (R$ 200), um cupom por quantidade para cada.
  const reservedTickets = [
    { ticketId: 't5', batchId: 'b5', unitPrice: 10000, quantity: 2 },
    { ticketId: 't10', batchId: 'b10', unitPrice: 20000, quantity: 2 },
  ];
  const coupon5 = { id: 'c5', code: null, couponType: 'QUANTITY', type: 'PERCENTAGE', value: 10, appliesTo: '["t5"]', applyToProducts: false };
  const coupon10 = { id: 'c10', code: null, couponType: 'QUANTITY', type: 'PERCENTAGE', value: 15, appliesTo: '["t10"]', applyToProducts: false };
  const base = {
    id: 'o1', status: 'PENDING', eventId: 'e1', reservedTickets, totalAmount: 60000, finalAmount: 52000, serviceFee: 0,
    voucherId: null, voucher: null, autoCouponId: null, autoCoupon: null, autoDiscount: null, event: { participantFeePercent: 0 },
  };
  // Principal = o de maior desconto (R$ 60 no 10km); extra = R$ 20 no 5km.
  const order = {
    ...base, couponId: 'c10', coupon: coupon10, discount: 8000,
    extraAutoCoupons: [{ couponId: 'c5', discount: 2000, coupon: coupon5 }],
  };

  it('cada cupom desconta do próprio ingresso e o total soma os dois', () => {
    const shaped = orderShape(order);
    expect(shaped.discount).toBe(8000);
    expect(shaped.finalAmount).toBe(52000);
    expect(shaped.reservedTickets.map((u: any) => [u.ticketId, u.unitDiscount])).toEqual([
      ['t5', 1000], ['t5', 1000], ['t10', 3000], ['t10', 3000],
    ]);
  });

  it('resumo: principal em couponDiscount, extra em autoCouponDiscount e uma linha por cupom', () => {
    const shaped = orderShape(order);
    expect(shaped.pricing.couponDiscount).toBe(6000);
    expect(shaped.pricing.autoCouponDiscount).toBe(2000);
    expect(shaped.autoCoupons).toEqual([
      { id: 'c5', code: null, couponType: 'QUANTITY', type: 'PERCENTAGE', value: 10, discount: 2000 },
    ]);
  });

  it('marca em cada unidade o automático que caiu nela', () => {
    const units = orderShape(order).reservedTickets;
    expect(units.map((u: any) => [u.ticketId, u.autoCouponId, u.autoCouponDiscount])).toEqual([
      ['t5', 'c5', 1000], ['t5', 'c5', 1000], ['t10', undefined, undefined], ['t10', undefined, undefined],
    ]);
  });

  it('não expõe a lista de documentos do cupom nas linhas do resumo', () => {
    const withList = {
      ...order,
      extraAutoCoupons: [{ couponId: 'c5', discount: 2000, coupon: { ...coupon5, documentList: ['123'], cpfList: ['123'] } }],
    };
    expect(JSON.stringify(orderShape(withList).autoCoupons)).not.toContain('123');
  });

  it('pedido sem extras segue idêntico ao cupom único', () => {
    const single = { ...base, couponId: 'c10', coupon: coupon10, discount: 6000, extraAutoCoupons: [] };
    const shaped = orderShape(single);
    expect(shaped.discount).toBe(6000);
    expect(shaped.autoCoupons).toBeUndefined();
    expect(shaped.pricing.autoCouponDiscount ?? 0).toBe(0);
  });

  it('com voucher os extras não valem', () => {
    const withVoucher = { ...order, couponId: null, coupon: null, voucherId: 'v1', discount: 0 };
    expect(orderShape(withVoucher).autoCoupons).toBeUndefined();
  });

  it('manual percentual incide sobre o valor já descontado de cada automático', () => {
    const manual = { id: 'm', code: 'TESTE', couponType: 'DISCOUNT', type: 'PERCENTAGE', value: 10, appliesTo: 'all', applyToProducts: false };
    const stacked = {
      ...base,
      couponId: 'm', coupon: manual, autoCouponId: 'c10', autoCoupon: coupon10, autoDiscount: 6000,
      extraAutoCoupons: [{ couponId: 'c5', discount: 2000, coupon: coupon5 }],
      discount: 6000 + 2000 + 6000, // manual cheio: 10% de R$ 600
    };
    const shaped = orderShape(stacked);
    // 5km: 100 − 10 = 90, manual 9. 10km: 200 − 30 = 170, manual 17.
    expect(shaped.reservedTickets.map((u: any) => u.unitDiscount)).toEqual([1900, 1900, 4700, 4700]);
    expect(shaped.discount).toBe(13200);
  });
});
