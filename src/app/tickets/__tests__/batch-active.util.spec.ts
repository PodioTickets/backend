/**
 * ============================================================================
 *  resolveActiveBatch — regra de FUSO do lote (wall-clock BRT +3h)
 * ============================================================================
 *  REGRESSÃO QUE ISTO TRAVA: `startDate`/`endDate` do lote são WALL-CLOCK
 *  gravados como UTC (ex.: "2030-01-10T09:30:00Z" = 09:30 no horário de Brasília
 *  pretendido pelo organizador). Comparar esse valor CRU com o instante real
 *  (`now`) abria/fechava o lote 3h CEDO no Brasil — o que fazia a tela do evento
 *  mostrar "Esgotado" ainda dentro do horário. A regra correta interpreta o
 *  wall-clock em BRT (UTC-3) via `eventWindowInstant` (+3h), a MESMA convenção da
 *  janela de inscrição (orders.reserve / registrations).
 * ============================================================================
 */
import { resolveActiveBatch, type BatchWithSold } from '../batch-active.util';

/** Lote BY_TIME com defaults; sobrescreva o que o caso precisar. */
function batch(over: Partial<BatchWithSold> = {}): BatchWithSold {
  return {
    id: over.id ?? 'b',
    quantity: over.quantity ?? 10,
    availableQuantity: over.availableQuantity ?? 10,
    price: over.price ?? 10000,
    startDate: over.startDate ?? null,
    endDate: over.endDate ?? null,
    sortOrder: over.sortOrder ?? 0,
    triggerType: over.triggerType ?? 'BY_TIME',
    quantitySold: over.quantitySold ?? 0,
  };
}

describe('resolveActiveBatch — fuso wall-clock BRT (+3h)', () => {
  // 2º lote com startDate wall-clock 12:00Z (= 12:00 BRT pretendido). O instante
  // real dessa virada é 15:00Z. Entre 12:00Z e 15:00Z o 2º lote AINDA NÃO deve abrir.
  const first = batch({ id: 'l1', sortOrder: 0, price: 5000 });
  const second = batch({
    id: 'l2',
    sortOrder: 1,
    price: 8000,
    startDate: new Date('2030-01-10T12:00:00.000Z'),
  });

  it('NÃO avança pro 2º lote no wall-clock cru (12:00Z) — abriria 3h cedo', () => {
    const now = new Date('2030-01-10T12:00:00.000Z');
    const { batch: active, batchNumber } = resolveActiveBatch([first, second], now);
    expect(active.id).toBe('l1');
    expect(batchNumber).toBe(1);
  });

  it('ainda no 1º lote 1min antes do instante real da virada (14:59Z)', () => {
    const now = new Date('2030-01-10T14:59:00.000Z');
    const { batch: active } = resolveActiveBatch([first, second], now);
    expect(active.id).toBe('l1');
  });

  it('avança pro 2º lote no instante real em BRT (15:00Z = 12:00 BRT)', () => {
    const now = new Date('2030-01-10T15:00:00.000Z');
    const { batch: active, batchNumber } = resolveActiveBatch([first, second], now);
    expect(active.id).toBe('l2');
    expect(batchNumber).toBe(2);
  });

  it('lote único sem datas: sempre ativo (status pelo saldo)', () => {
    const now = new Date('2030-01-10T12:00:00.000Z');
    const disponivel = resolveActiveBatch([batch({ availableQuantity: 3 })], now);
    expect(disponivel.status).toBe('AVAILABLE');
    const esgotado = resolveActiveBatch([batch({ availableQuantity: 0 })], now);
    expect(esgotado.status).toBe('SOLD_OUT');
  });

  it('AFTER_PREVIOUS_SOLD_OUT ignora datas: só abre quando o anterior vende tudo', () => {
    const l1 = batch({ id: 'l1', sortOrder: 0, quantity: 5, quantitySold: 4 });
    const l2 = batch({ id: 'l2', sortOrder: 1, triggerType: 'AFTER_PREVIOUS_SOLD_OUT' });
    const now = new Date('2030-01-10T20:00:00.000Z');
    expect(resolveActiveBatch([l1, l2], now).batch.id).toBe('l1');

    const l1SoldOut = batch({ id: 'l1', sortOrder: 0, quantity: 5, quantitySold: 5 });
    expect(resolveActiveBatch([l1SoldOut, l2], now).batch.id).toBe('l2');
  });
});
