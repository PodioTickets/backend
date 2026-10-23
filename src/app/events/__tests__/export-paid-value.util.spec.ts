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

describe('computeRegistrationPaidValues — troca de ingresso (voidedAt/replacedById)', () => {
  const T5 = { ticketId: 't5', batch: { price: 8900 } };
  const T10 = { ticketId: 't10', batch: { price: 12900 } };
  const T21 = { ticketId: 't21', batch: { price: 18900 } };
  // Após 5km(R$89) → 21km → 10km: a unidade do pedido é 10km a R$89 (preço pago mantido).
  const swapped = (id: string, replacedById: string, o: any, t: any) => ({
    ...reg({ id, order: o, tickets: [t] }),
    voidedAt: new Date(),
    replacedById,
  });

  it('trocadas repetem o valor da atual da vaga; ativa do mesmo ingresso não perde a unidade', () => {
    const o = order({
      id: 'o1',
      totalAmount: 8900 + 12900,
      reservedTickets: [
        { ticketId: 't10', unitPrice: 8900, quantity: 1 }, // vaga trocada (pagou R$89)
        { ticketId: 't10', unitPrice: 12900, quantity: 1 }, // outro participante
      ],
    });
    // Ordem do export: a trocada de 10km vem ANTES da ativa (antes roubava a unidade).
    const regs = [
      swapped('a-old5', 'b-old10', o, T5),
      swapped('b-old10', 'c-cur10', o, T10),
      reg({ id: 'c-cur10', order: o, tickets: [T10] }),
      reg({ id: 'd-outro10', order: o, tickets: [T10] }),
    ];
    const map = computeRegistrationPaidValues(regs);
    expect(map.get('c-cur10')).toBe(8900);
    expect(map.get('d-outro10')).toBe(12900);
    expect(map.get('a-old5')).toBe(8900);
    expect(map.get('b-old10')).toBe(8900);
  });

  it('produtos pagos na antiga contam na atual (a nova recebe produtos a R$ 0)', () => {
    const o = order({
      id: 'o2',
      totalAmount: 8900 + 3000,
      reservedTickets: [{ ticketId: 't10', unitPrice: 8900, quantity: 1 }],
    });
    const old = { ...swapped('old', 'cur', o, T5), products: [{ totalPrice: 3000 }] };
    const cur = reg({ id: 'cur', order: o, tickets: [T10], products: [{ totalPrice: 0 }] });
    const map = computeRegistrationPaidValues([old, cur]);
    expect(map.get('cur')).toBe(11900);
    expect(map.get('old')).toBe(11900);
  });

  it('atual fora do export (filtro): trocada cai no bruto do próprio ingresso', () => {
    const o = order({ id: 'o3', totalAmount: 8900, reservedTickets: [{ ticketId: 't10', unitPrice: 8900, quantity: 1 }] });
    const map = computeRegistrationPaidValues([swapped('old', 'fora', o, T21)]);
    expect(map.get('old')).toBe(18900);
  });
});
