import { computeRegistrationPaidValues } from '../export-paid-value.util';

/** Monta uma inscrição no shape que o export carrega (cru do Prisma). */
function reg(over: {
  id: string;
  order?: any;
  tickets?: any[];
  products?: any[];
}): any {
  return {
    id: over.id,
    order: over.order,
    tickets: over.tickets ?? [],
    products: over.products ?? [],
  };
}

function order(over: {
  id: string;
  discount?: number;
  totalAmount: number;
  reservedTickets?: any[];
  coupon?: any;
}): any {
  return {
    id: over.id,
    discount: over.discount ?? 0,
    totalAmount: over.totalAmount,
    reservedTickets: over.reservedTickets ?? [],
    coupon: over.coupon ?? null,
  };
}

describe('computeRegistrationPaidValues — valor pago por ingresso (recibo)', () => {
  it('sem desconto: valor = ingresso + produtos', () => {
    const o = order({
      id: 'o1',
      totalAmount: 12000,
      reservedTickets: [{ ticketId: 't1', unitPrice: 10000, quantity: 1 }],
    });
    const r = reg({
      id: 'r1',
      order: o,
      tickets: [{ ticketId: 't1', batch: { price: 10000 } }],
      products: [{ totalPrice: 2000 }],
    });
    const map = computeRegistrationPaidValues([r]);
    expect(map.get('r1')).toBe(12000);
  });

  it('voucher (1 ingresso grátis): valor = 0', () => {
    const o = order({
      id: 'o2',
      discount: 10000,
      totalAmount: 10000,
      reservedTickets: [{ ticketId: 't1', unitPrice: 10000, quantity: 1 }],
      coupon: null, // voucher → cupom nulo
    });
    const r = reg({
      id: 'r2',
      order: o,
      tickets: [{ ticketId: 't1', batch: { price: 10000 } }],
    });
    expect(computeRegistrationPaidValues([r]).get('r2')).toBe(0);
  });

  it('cupom FIXED cobre o ingresso mais caro: só a inscrição coberta desconta', () => {
    // 2 ingressos (10000 e 8000), cupom FIXED 5000 cobre 1 unidade (a mais cara).
    const o = order({
      id: 'o3',
      discount: 5000,
      totalAmount: 18000,
      reservedTickets: [
        { ticketId: 't1', unitPrice: 10000, quantity: 1 },
        { ticketId: 't2', unitPrice: 8000, quantity: 1 },
      ],
      coupon: { type: 'FIXED', value: 5000, appliesTo: 'all' },
    });
    const r1 = reg({ id: 'r1', order: o, tickets: [{ ticketId: 't1', batch: { price: 10000 } }] });
    const r2 = reg({ id: 'r2', order: o, tickets: [{ ticketId: 't2', batch: { price: 8000 } }] });
    const map = computeRegistrationPaidValues([r1, r2]);
    expect(map.get('r1')).toBe(5000); // 10000 − 5000
    expect(map.get('r2')).toBe(8000); // sem desconto
    // Soma bate com o total pago do pedido (18000 − 5000).
    expect((map.get('r1') ?? 0) + (map.get('r2') ?? 0)).toBe(13000);
  });

  it('cupom applyToProducts: porção que sobra dos ingressos rateia nos produtos', () => {
    // Ticket 10000 + produto 5000; cupom FIXED 13000 (cobre ingresso todo + 3000 do produto).
    const o = order({
      id: 'o4',
      discount: 13000,
      totalAmount: 15000,
      reservedTickets: [{ ticketId: 't1', unitPrice: 10000, quantity: 1 }],
      coupon: { type: 'FIXED', value: 13000, appliesTo: 'all' },
    });
    const r = reg({
      id: 'r4',
      order: o,
      tickets: [{ ticketId: 't1', batch: { price: 10000 } }],
      products: [{ totalPrice: 5000 }],
    });
    // ingresso net 0 + produto 5000 − 3000 = 2000 (== finalAmount 15000 − 13000).
    expect(computeRegistrationPaidValues([r]).get('r4')).toBe(2000);
  });

  it('percentual dividido entre 2 ingressos idênticos: cada um paga o líquido', () => {
    // 2 ingressos 10000, cupom 20% cobre ambos (discount 4000 = 20% de 20000).
    const o = order({
      id: 'o5',
      discount: 4000,
      totalAmount: 20000,
      reservedTickets: [{ ticketId: 't1', unitPrice: 10000, quantity: 2 }],
      coupon: { type: 'PERCENTAGE', value: 20, appliesTo: 'all' },
    });
    const r1 = reg({ id: 'r1', order: o, tickets: [{ ticketId: 't1', batch: { price: 10000 } }] });
    const r2 = reg({ id: 'r2', order: o, tickets: [{ ticketId: 't1', batch: { price: 10000 } }] });
    const map = computeRegistrationPaidValues([r1, r2]);
    expect(map.get('r1')).toBe(8000);
    expect(map.get('r2')).toBe(8000);
  });

  it('fallback: sem pedido/lotes → valor bruto (ingresso + produtos)', () => {
    const semPedido = reg({
      id: 'r6',
      tickets: [{ ticketId: 't1', batch: { price: 7000 } }],
      products: [{ totalPrice: 1000 }],
    });
    expect(computeRegistrationPaidValues([semPedido]).get('r6')).toBe(8000);

    const semLotes = reg({
      id: 'r7',
      order: order({ id: 'o7', totalAmount: 7000, reservedTickets: [] }),
      tickets: [{ ticketId: 't1', ticketSnapshot: { batch: { price: 7000 } } }],
    });
    expect(computeRegistrationPaidValues([semLotes]).get('r7')).toBe(7000);
  });
});
