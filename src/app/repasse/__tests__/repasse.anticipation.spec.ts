import {
  computeAnticipationCost,
  calendarDaysUntil,
  ANTICIPATION_MONTHLY_RATE,
  type AnticipatableOrder,
} from '../repasse.service';

/**
 * Custo da antecipação (função pura). Regra de dinheiro:
 *   custo_i = round(consumido_i × taxaMensal × dias_i / 30)
 * consumindo os pedidos MAIS ANTIGOS primeiro (menor paymentDate).
 */

const RATE = 0.02; // 2% a.m.

const order = (
  overrides: Partial<AnticipatableOrder> & Pick<AnticipatableOrder, 'orderId'>,
): AnticipatableOrder => ({
  netAmount: 10000,
  daysUntilRelease: 30,
  paymentDate: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

describe('computeAnticipationCost', () => {
  it('taxa mensal padrão é 2%', () => {
    expect(ANTICIPATION_MONTHLY_RATE).toBe(0.02);
  });

  it('pedido único, mês cheio (30 dias): custo = valor × taxa', () => {
    const orders = [order({ orderId: 'A', netAmount: 10000, daysUntilRelease: 30 })];
    const r = computeAnticipationCost(orders, 10000, RATE);
    expect(r.costAmount).toBe(200); // 10000 × 0.02 × 30/30
    expect(r.netAmount).toBe(9800);
    expect(r.breakdown).toEqual([{ orderId: 'A', amount: 10000, days: 30, cost: 200 }]);
  });

  it('prorrateia pelos dias (metade do mês = metade do custo)', () => {
    const orders = [order({ orderId: 'A', netAmount: 10000, daysUntilRelease: 15 })];
    const r = computeAnticipationCost(orders, 10000, RATE);
    expect(r.costAmount).toBe(100); // 10000 × 0.02 × 15/30
    expect(r.netAmount).toBe(9900);
  });

  it('consome o pedido MAIS ANTIGO primeiro (independe da ordem de entrada)', () => {
    // B é mais novo (paga depois, mais dias); A é mais antigo (menos dias).
    const orders = [
      order({ orderId: 'B', netAmount: 5000, daysUntilRelease: 20, paymentDate: new Date('2026-01-05T00:00:00Z') }),
      order({ orderId: 'A', netAmount: 5000, daysUntilRelease: 10, paymentDate: new Date('2026-01-01T00:00:00Z') }),
    ];
    const r = computeAnticipationCost(orders, 6000, RATE);
    // A inteiro (5000, 10d) + 1000 de B (20d)
    const costA = Math.round(5000 * RATE * (10 / 30)); // 33
    const costB = Math.round(1000 * RATE * (20 / 30)); // 13
    expect(r.breakdown.map((b) => b.orderId)).toEqual(['A', 'B']);
    expect(r.breakdown[0]).toEqual({ orderId: 'A', amount: 5000, days: 10, cost: costA });
    expect(r.breakdown[1]).toEqual({ orderId: 'B', amount: 1000, days: 20, cost: costB });
    expect(r.costAmount).toBe(costA + costB);
    expect(r.netAmount).toBe(6000 - (costA + costB));
  });

  it('valor 0 → custo 0, líquido 0, sem breakdown', () => {
    const r = computeAnticipationCost([order({ orderId: 'A' })], 0, RATE);
    expect(r).toEqual({ costAmount: 0, netAmount: 0, breakdown: [] });
  });

  it('para de consumir ao cobrir o valor (não usa pedidos sobrando)', () => {
    const orders = [
      order({ orderId: 'A', netAmount: 3000, daysUntilRelease: 10, paymentDate: new Date('2026-01-01T00:00:00Z') }),
      order({ orderId: 'B', netAmount: 3000, daysUntilRelease: 10, paymentDate: new Date('2026-01-02T00:00:00Z') }),
    ];
    const r = computeAnticipationCost(orders, 2000, RATE);
    expect(r.breakdown).toHaveLength(1);
    expect(r.breakdown[0]).toEqual({ orderId: 'A', amount: 2000, days: 10, cost: Math.round(2000 * RATE * (10 / 30)) });
  });
});

describe('calendarDaysUntil (âncora BRT = UTC-3)', () => {
  // Conta por DIA CIVIL de BRASÍLIA — bate com a data exibida (`formatDateBRT`) e com
  // o custo da antecipação; não é o ceil da fração nem o dia civil UTC. Como release e
  // now são instantes reais, contar em UTC deslocava tudo pro Brasil (dia +1 à noite e
  // custo oscilando por hora). Ex.: hoje 11/08 BRT, liberação 20/08 BRT → 9.
  it('conta dias de calendário em BRT, ignorando a hora do dia (9, não 10)', () => {
    const now = new Date('2026-08-11T13:00:00Z'); // 10:00 BRT, 11/08
    // Liberação 9 dias à frente (11:30 BRT do 20/08): o ceil daria 10; o dia civil dá 9.
    expect(calendarDaysUntil(new Date('2026-08-20T14:30:00Z'), now)).toBe(9);
    // Mesmo dia civil BRT (manhã e noite do 20/08) → ainda 9.
    expect(calendarDaysUntil(new Date('2026-08-20T12:00:00Z'), now)).toBe(9); // 09:00 BRT 20/08
    expect(calendarDaysUntil(new Date('2026-08-21T02:00:00Z'), now)).toBe(9); // 23:00 BRT 20/08
  });

  it('instante à noite no Brasil cai no dia civil BRT correto (não sobe pro dia UTC)', () => {
    const now = new Date('2026-08-11T13:00:00Z'); // 10:00 BRT 11/08
    // 00:00:01Z do dia 20 = 21:00:01 BRT do dia 19 → dia civil 19/08 → 8 dias (não 9).
    // É exatamente o off-by-one que UTC causava: em UTC daria 9.
    expect(calendarDaysUntil(new Date('2026-08-20T00:00:01Z'), now)).toBe(8);
  });

  it('estável dentro do MESMO dia civil BRT (não oscila durante o dia)', () => {
    const rel = new Date('2026-08-20T14:30:00Z'); // 11:30 BRT 20/08
    // Início e fim do dia civil BRT 11/08 (00:00 → 03:00Z; 23:59:59 → 02:59:59Z do 12).
    expect(calendarDaysUntil(rel, new Date('2026-08-11T03:00:00Z'))).toBe(9);
    expect(calendarDaysUntil(rel, new Date('2026-08-12T02:59:59Z'))).toBe(9);
  });

  it('libera hoje (BRT) → 0; ontem → negativo', () => {
    const now = new Date('2026-08-11T13:00:00Z'); // 10:00 BRT 11/08
    expect(calendarDaysUntil(new Date('2026-08-12T01:00:00Z'), now)).toBe(0); // 22:00 BRT 11/08
    expect(calendarDaysUntil(new Date('2026-08-10T20:00:00Z'), now)).toBe(-1); // 17:00 BRT 10/08
  });
});
