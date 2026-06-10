import {
  holdsStock,
  acquireVariationHold,
  releaseVariationHold,
  incrementVariationSold,
  decrementVariationSold,
} from '../product-stock.util';

/**
 * Cobre a regra de negócio central (quem segura estoque) e o contrato dos helpers de escrita
 * atômica (delegam ao $executeRaw e retornam o nº de linhas afetadas — usado pelo guard de
 * "esgotado" no checkout).
 */
describe('product-stock.util', () => {
  describe('holdsStock — opcional OU não-incluso segura estoque', () => {
    it('incluso E obrigatório → NÃO segura (gated pelo ingresso)', () => {
      expect(holdsStock({ isIncludedInTicket: true, isRequired: true })).toBe(false);
    });
    it('incluso mas opcional → segura', () => {
      expect(holdsStock({ isIncludedInTicket: true, isRequired: false })).toBe(true);
    });
    it('não-incluso obrigatório → segura', () => {
      expect(holdsStock({ isIncludedInTicket: false, isRequired: true })).toBe(true);
    });
    it('não-incluso opcional → segura', () => {
      expect(holdsStock({ isIncludedInTicket: false, isRequired: false })).toBe(true);
    });
    it('flags ausentes (undefined/null) → segura (default conservador)', () => {
      expect(holdsStock({})).toBe(true);
      expect(holdsStock({ isIncludedInTicket: null, isRequired: null })).toBe(true);
    });
  });

  describe('helpers de escrita → delegam ao $executeRaw e retornam o rowCount', () => {
    const mkTx = (rowCount: number) => ({ $executeRaw: jest.fn().mockResolvedValue(rowCount) });

    it('acquireVariationHold retorna rowCount (0 = esgotado)', async () => {
      const tx = mkTx(0);
      const r = await acquireVariationHold(tx as any, 'v1', 2);
      expect(r).toBe(0);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('releaseVariationHold delega ao $executeRaw', async () => {
      const tx = mkTx(1);
      await releaseVariationHold(tx as any, 'v1', 3);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('incrementVariationSold delega ao $executeRaw', async () => {
      const tx = mkTx(1);
      await incrementVariationSold(tx as any, 'v1', 1);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('decrementVariationSold delega ao $executeRaw', async () => {
      const tx = mkTx(1);
      await decrementVariationSold(tx as any, 'v1', 1);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    });
  });
});
