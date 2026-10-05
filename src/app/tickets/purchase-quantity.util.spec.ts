import { BadRequestException } from '@nestjs/common';
import { assertPurchaseQuantityRange, purchaseQuantityError } from './purchase-quantity.util';

describe('purchase-quantity.util', () => {
  const t = (min: number | null, max: number | null) => ({ name: 'X', minPurchaseQuantity: min, maxPurchaseQuantity: max });

  it('aceita dentro da faixa e sem limites', () => {
    expect(purchaseQuantityError(t(null, null), 15)).toBeNull();
    expect(purchaseQuantityError(t(2, 4), 2)).toBeNull();
    expect(purchaseQuantityError(t(2, 4), 4)).toBeNull();
  });

  it('barra abaixo do mínimo e acima do máximo', () => {
    expect(purchaseQuantityError(t(2, null), 1)).toMatch(/mínimo 2/);
    expect(purchaseQuantityError(t(null, 3), 4)).toMatch(/máximo 3 unidades/);
    expect(purchaseQuantityError(t(null, 1), 2)).toMatch(/máximo 1 unidade /);
  });

  it('mínimo > máximo é inválido', () => {
    expect(() => assertPurchaseQuantityRange(5, 3)).toThrow(BadRequestException);
    expect(() => assertPurchaseQuantityRange(3, 3)).not.toThrow();
    expect(() => assertPurchaseQuantityRange(null, 3)).not.toThrow();
  });
});
