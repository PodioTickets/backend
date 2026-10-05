import { ageOnEventDay, swapEligibilityError, swapProductsError } from './registration-swap.util';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('registration-swap.util', () => {
  describe('ageOnEventDay', () => {
    it('conta a idade no dia do evento (faz aniversário no dia → já conta)', () => {
      expect(ageOnEventDay(d('2008-12-15'), d('2026-12-15'))).toBe(18);
      expect(ageOnEventDay(d('2008-12-16'), d('2026-12-15'))).toBe(17);
    });
  });

  describe('swapEligibilityError', () => {
    const free = { ageLimitMin: null, ageLimitMax: null, gender: null };

    it('ingresso sem restrição aceita qualquer participante', () => {
      expect(swapEligibilityError({ dateOfBirth: null, gender: null }, free, null)).toBeNull();
    });

    it('barra fora da faixa de idade no dia do evento', () => {
      const ticket = { ...free, ageLimitMin: 9, ageLimitMax: 11 };
      const event = d('2026-12-01');
      expect(swapEligibilityError({ dateOfBirth: d('2016-01-01'), gender: 'M' }, ticket, event)).toBeNull();
      expect(swapEligibilityError({ dateOfBirth: d('2018-01-01'), gender: 'M' }, ticket, event)).toMatch(/mínima/);
      expect(swapEligibilityError({ dateOfBirth: d('2010-01-01'), gender: 'M' }, ticket, event)).toMatch(/máxima/);
    });

    it('barra participante sem nascimento quando há limite de idade', () => {
      expect(swapEligibilityError({ dateOfBirth: null, gender: 'M' }, { ...free, ageLimitMin: 18 }, null)).toMatch(
        /nascimento/,
      );
    });

    it('respeita o gênero do ingresso (all = livre)', () => {
      expect(swapEligibilityError({ dateOfBirth: null, gender: 'Feminino' }, { ...free, gender: 'MALE' }, null)).toMatch(
        /masculino/,
      );
      expect(swapEligibilityError({ dateOfBirth: null, gender: 'masculino' }, { ...free, gender: 'MALE' }, null)).toBeNull();
      expect(swapEligibilityError({ dateOfBirth: null, gender: 'M' }, { ...free, gender: 'FEMALE' }, null)).toMatch(
        /feminino/,
      );
      expect(swapEligibilityError({ dateOfBirth: null, gender: null }, { ...free, gender: 'ALL' }, null)).toBeNull();
    });
  });

  describe('swapProductsError', () => {
    const allowed = [
      { id: 'kit', name: 'Camiseta', isRequired: true, variations: [{ id: 'P' }, { id: 'M' }] },
      { id: 'extra', name: 'Garrafa', isRequired: false, variations: [] },
    ];

    it('aceita seleção válida', () => {
      expect(swapProductsError(allowed, [{ productId: 'kit', variationId: 'M' }])).toBeNull();
      expect(
        swapProductsError(allowed, [{ productId: 'kit', variationId: 'P' }, { productId: 'extra' }]),
      ).toBeNull();
    });

    it('exige o obrigatório e a variação quando houver', () => {
      expect(swapProductsError(allowed, [])).toMatch(/Camiseta/);
      expect(swapProductsError(allowed, [{ productId: 'kit' }])).toMatch(/Camiseta/);
      expect(swapProductsError(allowed, [{ productId: 'kit', variationId: 'X' }])).toMatch(/inválida/);
      // Obrigatório SEM variação não é exigido (nunca vira item, como na compra).
      expect(
        swapProductsError([{ id: 'medalha', name: 'Medalha', isRequired: true, variations: [] }], []),
      ).toBeNull();
    });

    it('recusa produto fora do ingresso e repetido', () => {
      expect(swapProductsError(allowed, [{ productId: 'outro' }])).toMatch(/não disponível/);
      expect(
        swapProductsError(allowed, [
          { productId: 'kit', variationId: 'P' },
          { productId: 'kit', variationId: 'M' },
        ]),
      ).toMatch(/repetido/);
    });
  });
});
