import {
  buildVariationChoices,
  buildVariationLabel,
  pickPricingVariation,
  resolveVariationSelection,
} from './product-variation.util';

/** Kit Camisa (P/M) + Short (P/G) com o opt-out "Sem interesse" (sem grupo). */
const kit = {
  name: 'Kit',
  variationGroups: [
    { id: 'g-camisa', name: 'Camisa', sortOrder: 0 },
    { id: 'g-short', name: 'Short', sortOrder: 1 },
  ],
  variations: [
    { id: 'c-p', name: 'P', groupId: 'g-camisa', price: 0 },
    { id: 'c-m', name: 'M', groupId: 'g-camisa', price: 0 },
    { id: 's-p', name: 'P', groupId: 'g-short', price: 0 },
    { id: 's-g', name: 'G', groupId: 'g-short', price: 0 },
    { id: 'no', name: 'Sem interesse', groupId: null, price: 0 },
  ],
};

describe('"Sem interesse" por variação (27/11)', () => {
  it('sozinho continua recusando o kit inteiro', () => {
    const r = resolveVariationSelection(kit, ['no']);
    expect(r.error).toBeUndefined();
    expect(r.variations?.map((v) => v.id)).toEqual(['no']);
  });

  it('junto de uma opção: aceita, variação sem escolha fica em "Sem interesse", opt-out por último', () => {
    const r = resolveVariationSelection(kit, ['no', 's-g']);
    expect(r.error).toBeUndefined();
    expect(r.variations?.map((v) => v.id)).toEqual(['s-g', 'no']);
  });

  it('sem "Sem interesse" continua exigindo uma opção por variação', () => {
    expect(resolveVariationSelection(kit, ['s-g']).error).toBe('Escolha uma opção de "Camisa" para "Kit".');
  });

  it('duas opções da mesma variação continuam inválidas', () => {
    expect(resolveVariationSelection(kit, ['c-p', 'c-m', 'no']).error).toBe(
      'Escolha apenas uma opção por variação para "Kit".',
    );
  });

  it('preço: só o opt-out sozinho zera; com opção real cobra a opção', () => {
    const no = { name: 'Sem interesse', price: 0 };
    const g = { name: 'G', price: 3000 };
    expect(pickPricingVariation([no])).toBe(no);
    expect(pickPricingVariation([g, no])).toBe(g);
  });

  it('rótulo: "Camisa: Sem interesse · Short: G"', () => {
    const choices = buildVariationChoices(['s-g', 'no'], kit.variations, kit.variationGroups);
    expect(buildVariationLabel(choices)).toBe('Camisa: Sem interesse · Short: G');
  });

  it('kit obrigatório recusa "Sem interesse" (sozinho ou junto de opções)', () => {
    const obrigatorio = { ...kit, isRequired: true };
    expect(resolveVariationSelection(obrigatorio, ['no']).error).toBe(
      '"Sem interesse" não está disponível para "Kit": o kit é obrigatório.',
    );
    expect(resolveVariationSelection(obrigatorio, ['s-g', 'no']).error).toBeDefined();
    expect(resolveVariationSelection(obrigatorio, ['c-p', 's-g']).error).toBeUndefined();
  });

  it('rótulo do kit recusado inteiro continua "Sem interesse"', () => {
    expect(buildVariationLabel(buildVariationChoices(['no'], kit.variations, kit.variationGroups))).toBe(
      'Sem interesse',
    );
  });
});
