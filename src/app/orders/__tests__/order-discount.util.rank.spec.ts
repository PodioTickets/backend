import { rankAutoCouponCandidates } from '../order-discount.util';

// Regra de 2026-09-30: o mais vantajoso; empate → o já aplicado; senão a ordem recebida (1º criado).
describe('rankAutoCouponCandidates', () => {
  const c = (id: string, discount: number) => ({ coupon: { id }, discount });

  it('maior desconto primeiro', () => {
    expect(rankAutoCouponCandidates([c('a', 10), c('b', 30), c('c', 20)]).map((x) => x.coupon.id)).toEqual(['b', 'c', 'a']);
  });

  it('empate → o já aplicado vence', () => {
    expect(rankAutoCouponCandidates([c('a', 10), c('b', 10)], 'b')[0].coupon.id).toBe('b');
  });

  it('empate sem aplicado → mantém a ordem recebida', () => {
    expect(rankAutoCouponCandidates([c('a', 10), c('b', 10)], null)[0].coupon.id).toBe('a');
  });

  it('não muta a entrada', () => {
    const input = [c('a', 1), c('b', 2)];
    rankAutoCouponCandidates(input);
    expect(input.map((x) => x.coupon.id)).toEqual(['a', 'b']);
  });
});
