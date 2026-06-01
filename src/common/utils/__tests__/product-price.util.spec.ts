import { resolveProductUnitPrice } from '../product-price.util';

describe('resolveProductUnitPrice', () => {
  describe('produto INCLUSO no ingresso → nunca cobrado (0)', () => {
    it('incluso sem variação → 0 (mesmo com basePrice)', () => {
      expect(resolveProductUnitPrice({ isIncludedInTicket: true, basePrice: 5000 }, null)).toBe(0);
    });
    it('incluso OPCIONAL (não obrigatório) → 0', () => {
      const product = { isIncludedInTicket: true, isRequired: false, basePrice: 5000 };
      expect(resolveProductUnitPrice(product, { name: 'M', price: 7000 })).toBe(0);
    });
    it('incluso com variação paga → ainda 0 (precede a regra de variação)', () => {
      const product = { isIncludedInTicket: true, basePrice: 3000 };
      expect(resolveProductUnitPrice(product, { name: 'GG', price: 9000 })).toBe(0);
    });
  });

  describe('produto NÃO incluso (adicional) → regras de variação', () => {
    it('sem variação → basePrice', () => {
      expect(resolveProductUnitPrice({ isIncludedInTicket: false, basePrice: 5000 }, null)).toBe(5000);
    });
    it('variação "Sem interesse" → 0 (opt-out)', () => {
      expect(resolveProductUnitPrice({ basePrice: 5000 }, { name: 'Sem interesse', price: 0 })).toBe(0);
    });
    it('variação com price > 0 → price da variação', () => {
      expect(resolveProductUnitPrice({ basePrice: 5000 }, { name: 'M', price: 7000 })).toBe(7000);
    });
    it('variação com price 0 (não "Sem interesse") → fallback basePrice', () => {
      expect(resolveProductUnitPrice({ basePrice: 5000 }, { name: 'P', price: 0 })).toBe(5000);
    });
    it('produto undefined-safe → 0', () => {
      expect(resolveProductUnitPrice(null, null)).toBe(0);
    });
  });
});
