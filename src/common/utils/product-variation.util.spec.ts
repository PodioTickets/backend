import { describeRegistrationProductVariations } from './product-variation.util';

describe('describeRegistrationProductVariations', () => {
  it('mantém grupo e ordem quando rp.variation vem enxuta (sem groupId)', () => {
    const rp = {
      variationId: 'm',
      variationIds: ['m', 'g'],
      // Select enxuto do export/fiscal: sem groupId.
      variation: { id: 'm', name: 'M' },
      product: {
        variationGroups: [
          { id: 'camisa', name: 'Tamanho da camisa', sortOrder: 0 },
          { id: 'short', name: 'Tamanho do short', sortOrder: 1 },
        ],
        variations: [
          { id: 'm', name: 'M', groupId: 'camisa' },
          { id: 'g', name: 'G', groupId: 'short' },
        ],
      },
    };

    expect(describeRegistrationProductVariations(rp).variationLabel).toBe(
      'Tamanho da camisa: M · Tamanho do short: G',
    );
  });
});
