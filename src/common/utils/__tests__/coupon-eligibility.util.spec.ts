import {
  computeCouponCoveredUnits,
  computeDocEligibleSlots,
  computeAgeEligibleSlots,
  computeAgeCouponEligibleSlots,
} from '../coupon-eligibility.util';

// ── helpers ──────────────────────────────────────────────────────────────────
const rt = (ticketId: string, quantity: number) => ({ ticketId, quantity, unitPrice: 10000 });
const cpfDoc = (numberClean: string) => ({ type: 'CPF', numberClean });
const partCpf = (cpf: string) => ({ documentType: 'CPF', documentNumber: cpf });
// idade: nasceu em 2000-01-01; na data de ref 2020-01-01 tem 20 anos.
const partBorn = (iso: string) => ({ birthDate: iso });
// participante com idade E documento (para AGE + lista exclusiva).
const partBornCpf = (iso: string, cpf: string) => ({ birthDate: iso, documentType: 'CPF', documentNumber: cpf });
const REF = new Date('2020-01-01T00:00:00Z');

describe('computeCouponCoveredUnits (uso = nº de ingressos cobertos)', () => {
  it('QUANTITY → 1 (all-or-nothing por pedido, não por ingresso)', () => {
    expect(
      computeCouponCoveredUnits({ couponType: 'QUANTITY' }, [rt('A', 3)], [], REF),
    ).toBe(1);
  });

  it('DISCOUNT sem lista → todos os ingressos aplicáveis', () => {
    expect(
      computeCouponCoveredUnits({ couponType: 'DISCOUNT' }, [rt('A', 2), rt('B', 1)], [], REF),
    ).toBe(3);
  });

  it('DISCOUNT com appliesTo restrito → só os ingressos permitidos', () => {
    const coupon = { couponType: 'DISCOUNT', appliesTo: JSON.stringify(['A']) };
    expect(computeCouponCoveredUnits(coupon, [rt('A', 2), rt('B', 5)], [], REF)).toBe(2);
  });

  it('BUG: DISCOUNT + cpfList, 1 elegível de 2 → cobre 1 (não 2)', () => {
    const coupon = { couponType: 'DISCOUNT', cpfListStatus: 'ENABLED', cpfList: ['11111111111'] };
    const participants = [partCpf('11111111111'), partCpf('99999999999')];
    expect(computeCouponCoveredUnits(coupon, [rt('A', 2)], participants, REF)).toBe(1);
  });

  it('BUG: AGE, 1 participante na faixa de 2 → cobre 1 (não 2)', () => {
    const coupon = { couponType: 'AGE', minAge: 18, maxAge: 25 };
    // p1 tem 20 (na faixa); p2 tem 40 (fora).
    const participants = [partBorn('2000-01-01'), partBorn('1980-01-01')];
    expect(computeCouponCoveredUnits(coupon, [rt('A', 2)], participants, REF)).toBe(1);
  });

  it('AGE: ambos na faixa → cobre 2', () => {
    const coupon = { couponType: 'AGE', minAge: 18, maxAge: 25 };
    const participants = [partBorn('2000-01-01'), partBorn('2001-01-01')];
    expect(computeCouponCoveredUnits(coupon, [rt('A', 2)], participants, REF)).toBe(2);
  });

  it('AGE + lista exclusiva: 2 na faixa mas só 1 na lista → cobre 1 (idade E lista)', () => {
    const coupon = {
      couponType: 'AGE', minAge: 18, maxAge: 25,
      cpfListStatus: 'ENABLED', cpfList: ['11111111111'],
    };
    // ambos com 20 anos; só o 1º está na lista.
    const participants = [partBornCpf('2000-01-01', '11111111111'), partBornCpf('2000-06-01', '99999999999')];
    expect(computeCouponCoveredUnits(coupon, [rt('A', 2)], participants, REF)).toBe(1);
  });

  it('AGE + lista exclusiva: na lista mas FORA da faixa → cobre 0 (interseção, não união)', () => {
    const coupon = {
      couponType: 'AGE', minAge: 18, maxAge: 25,
      cpfListStatus: 'ENABLED', cpfList: ['11111111111'],
    };
    // documento na lista, porém 40 anos (fora da faixa) → não cobre.
    const participants = [partBornCpf('1980-01-01', '11111111111')];
    expect(computeCouponCoveredUnits(coupon, [rt('A', 1)], participants, REF)).toBe(0);
  });

  it('AGE + lista DISABLED → só idade (lista ignorada)', () => {
    const coupon = {
      couponType: 'AGE', minAge: 18, maxAge: 25,
      cpfListStatus: 'DISABLED', cpfList: ['11111111111'],
    };
    const participants = [partBornCpf('2000-01-01', '99999999999')];
    expect(computeCouponCoveredUnits(coupon, [rt('A', 1)], participants, REF)).toBe(1);
  });

  it('capa pelo nº de ingressos aplicáveis (mais elegíveis que ingressos)', () => {
    const coupon = { couponType: 'AGE', minAge: 18, maxAge: 25 };
    const participants = [partBorn('2000-01-01'), partBorn('2001-01-01'), partBorn('2002-01-01')];
    expect(computeCouponCoveredUnits(coupon, [rt('A', 1)], participants, REF)).toBe(1);
  });

  it('nenhum ingresso aplicável → 0', () => {
    const coupon = { couponType: 'DISCOUNT', appliesTo: JSON.stringify(['Z']) };
    expect(computeCouponCoveredUnits(coupon, [rt('A', 2)], [], REF)).toBe(0);
  });

  it('cupom nulo → 0', () => {
    expect(computeCouponCoveredUnits(null, [rt('A', 2)], [], REF)).toBe(0);
  });

  // sanidade dos helpers movidos (mesma assinatura de antes)
  it('helpers re-exportáveis seguem funcionando (doc/age slots)', () => {
    expect(computeDocEligibleSlots([partCpf('11111111111')], [cpfDoc('11111111111')], null, 1)).toEqual([0]);
    expect(computeAgeEligibleSlots([partBorn('2000-01-01')], 18, 25, REF, 1)).toEqual([0]);
  });
});

describe('computeAgeCouponEligibleSlots (AGE + lista exclusiva = interseção)', () => {
  const ageCoupon = (extra: Record<string, unknown> = {}) => ({ minAge: 18, maxAge: 25, ...extra });

  it('lista DISABLED → equivale a computeAgeEligibleSlots (só idade)', () => {
    const participants = [partBornCpf('2000-01-01', '99999999999'), partBorn('1980-01-01')];
    expect(computeAgeCouponEligibleSlots(participants, ageCoupon(), REF, 2)).toEqual([0]);
  });

  it('lista ENABLED → idade E documento (interseção dos slots)', () => {
    const coupon = ageCoupon({ cpfListStatus: 'ENABLED', cpfList: ['11111111111'] });
    // idx0: idade+lista ✓ | idx1: idade mas fora da lista ✗ | idx2: na lista mas fora da faixa ✗
    const participants = [
      partBornCpf('2000-01-01', '11111111111'),
      partBornCpf('2000-06-01', '99999999999'),
      partBornCpf('1980-01-01', '11111111111'),
    ];
    expect(computeAgeCouponEligibleSlots(participants, coupon, REF, 3)).toEqual([0]);
  });

  it('lenient=true: slot sem birthDate/documento mantém provisório (PENDING)', () => {
    const coupon = ageCoupon({ cpfListStatus: 'ENABLED', cpfList: ['11111111111'] });
    const participants = [partBornCpf('2000-01-01', '11111111111'), {}]; // idx1 vazio
    expect(computeAgeCouponEligibleSlots(participants, coupon, REF, 2, true)).toEqual([0, 1]);
    // estrito (pay): slot vazio NÃO conta.
    expect(computeAgeCouponEligibleSlots(participants, coupon, REF, 2, false)).toEqual([0]);
  });

  it('documentList internacionalizado (PASSPORT) intersecta com idade', () => {
    const coupon = ageCoupon({ cpfListStatus: 'ENABLED', documentList: [{ type: 'PASSPORT', numberClean: 'AB123' }] });
    const participants = [{ birthDate: '2000-01-01', documentType: 'PASSPORT', documentNumber: 'ab-123' }];
    expect(computeAgeCouponEligibleSlots(participants, coupon, REF, 1)).toEqual([0]);
  });
});
