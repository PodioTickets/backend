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

describe('resolveActiveBatch — janela BY_TIME encerra + fallback por esgotamento', () => {
  // Instante real da virada = wall-clock +3h. endDate 18:00Z → encerra às 21:00Z.
  const window = {
    start: new Date('2030-03-01T09:00:00.000Z'), // abre 12:00Z real
    end: new Date('2030-03-01T18:00:00.000Z'), // encerra 21:00Z real
  };

  it('lote por tempo com estoque, DENTRO da janela → disponível', () => {
    const l1 = batch({ id: 'l1', sortOrder: 0, startDate: window.start, endDate: window.end, availableQuantity: 5 });
    const now = new Date('2030-03-01T15:00:00.000Z'); // dentro (12:00–21:00 real)
    const r = resolveActiveBatch([l1], now);
    expect(r.batch.id).toBe('l1');
    expect(r.status).toBe('AVAILABLE');
  });

  it('BUG REPORTADO: lote por tempo ENCERRADO com estoque, sem fallback → ESGOTADO (não "disponível")', () => {
    const l1 = batch({ id: 'l1', sortOrder: 0, startDate: window.start, endDate: window.end, availableQuantity: 5 });
    const now = new Date('2030-03-01T22:00:00.000Z'); // após 21:00Z real
    const r = resolveActiveBatch([l1], now);
    expect(r.batch.id).toBe('l1');
    expect(r.status).toBe('SOLD_OUT');
  });

  it('lote por tempo encerra e o PRÓXIMO por tempo ainda não abriu (intervalo) → ESGOTADO', () => {
    const l1 = batch({ id: 'l1', sortOrder: 0, startDate: window.start, endDate: window.end, availableQuantity: 3 });
    const l2 = batch({ id: 'l2', sortOrder: 1, startDate: new Date('2030-03-05T09:00:00.000Z'), availableQuantity: 10 });
    const now = new Date('2030-03-02T00:00:00.000Z'); // depois da janela de l1, antes de l2
    const r = resolveActiveBatch([l1, l2], now);
    expect(r.status).toBe('SOLD_OUT');
  });

  it('FALLBACK: lote por esgotamento (aberto, com vaga) reassume quando o lote por tempo seguinte encerra', () => {
    // Config real: L1 base por tempo (esgotou) → L2 por esgotamento abriu com vaga
    // → L3 por tempo teve janela e ENCERROU. Fallback deve reativar L2.
    const l1Base = batch({ id: 'l1', sortOrder: 0, quantity: 5, quantitySold: 5, availableQuantity: 0 });
    const l2 = batch({ id: 'l2', sortOrder: 1, triggerType: 'AFTER_PREVIOUS_SOLD_OUT', quantity: 10, quantitySold: 4, availableQuantity: 6 });
    const l3 = batch({ id: 'l3', sortOrder: 2, startDate: window.start, endDate: window.end, availableQuantity: 2 });
    const now = new Date('2030-03-01T22:00:00.000Z'); // após a janela de l3
    const r = resolveActiveBatch([l1Base, l2, l3], now);
    expect(r.batch.id).toBe('l2');
    expect(r.status).toBe('AVAILABLE');
  });

  it('FALLBACK esgotado: lote por esgotamento anterior SEM vaga → ingresso permanece esgotado', () => {
    const l1Base = batch({ id: 'l1', sortOrder: 0, quantity: 5, quantitySold: 5, availableQuantity: 0 });
    const l2Empty = batch({ id: 'l2', sortOrder: 1, triggerType: 'AFTER_PREVIOUS_SOLD_OUT', quantity: 10, quantitySold: 10, availableQuantity: 0 });
    const l3 = batch({ id: 'l3', sortOrder: 2, startDate: window.start, endDate: window.end, availableQuantity: 2 });
    const now = new Date('2030-03-01T22:00:00.000Z');
    const r = resolveActiveBatch([l1Base, l2Empty, l3], now);
    expect(r.status).toBe('SOLD_OUT');
  });

  it('NÃO reabre lote por esgotamento que jamais abriu; cai no lote base elegível com vaga', () => {
    // L1 base por tempo com vaga (NÃO esgotou) → L2 por esgotamento nunca abriu.
    // L3 por tempo teve janela e encerrou. Fallback pula L2 (nunca abriu) e reabre
    // L1 (dentro da janela, com vaga).
    const l1Base = batch({ id: 'l1', sortOrder: 0, quantity: 5, quantitySold: 2, availableQuantity: 3 });
    const l2NeverOpened = batch({ id: 'l2', sortOrder: 1, triggerType: 'AFTER_PREVIOUS_SOLD_OUT', quantity: 10, quantitySold: 0, availableQuantity: 10 });
    const l3 = batch({ id: 'l3', sortOrder: 2, startDate: window.start, endDate: window.end, availableQuantity: 2 });
    const now = new Date('2030-03-01T22:00:00.000Z');
    const r = resolveActiveBatch([l1Base, l2NeverOpened, l3], now);
    expect(r.batch.id).toBe('l1');
    expect(r.status).toBe('AVAILABLE');
  });

  it('ESTORNO reabre o LOTE ANTIGO por tempo: assento devolvido a um lote anterior dentro da janela, com o lote atual esgotado', () => {
    // L1 por tempo (janela aberta, sem fim), estava esgotado e o estorno devolveu 1
    // vaga. L2 por tempo começou depois (ativo) e está esgotado. O ingresso deve
    // voltar à venda no L1 (lote de origem), não ficar preso no L2 esgotado.
    const l1 = batch({
      id: 'l1',
      sortOrder: 0,
      startDate: new Date('2030-03-01T06:00:00.000Z'), // inst 09:00Z
      endDate: null, // sem fim → ainda dentro da janela
      quantity: 5,
      availableQuantity: 1, // restaurado pelo estorno
    });
    const l2 = batch({
      id: 'l2',
      sortOrder: 1,
      startDate: new Date('2030-03-01T09:00:00.000Z'), // inst 12:00Z (começou depois)
      quantity: 5,
      availableQuantity: 0, // esgotado
    });
    const now = new Date('2030-03-01T15:00:00.000Z'); // após ambos abrirem
    const r = resolveActiveBatch([l1, l2], now);
    expect(r.batch.id).toBe('l1');
    expect(r.status).toBe('AVAILABLE');
  });

  it('ESTORNO reabre o lote anterior MESMO com a janela dele encerrada (limbo): assento devolvido volta à venda no lote de origem', () => {
    // L1 por tempo ENCERRADO com vaga devolvida (estorno), L2 por tempo ativo esgotado.
    // O assento devolvido volta à venda no L1 (lote de origem) — o ingresso não fica preso.
    const l1Ended = batch({
      id: 'l1',
      sortOrder: 0,
      startDate: window.start,
      endDate: window.end, // encerra 21:00Z
      quantity: 5,
      availableQuantity: 1, // vaga devolvida pelo estorno
    });
    const l2 = batch({
      id: 'l2',
      sortOrder: 1,
      startDate: new Date('2030-03-01T12:00:00.000Z'), // inst 15:00Z
      quantity: 5,
      availableQuantity: 0,
    });
    const now = new Date('2030-03-01T22:00:00.000Z'); // após a janela do L1
    const r = resolveActiveBatch([l1Ended, l2], now);
    expect(r.batch.id).toBe('l1');
    expect(r.status).toBe('AVAILABLE');
  });
});

describe('resolveActiveBatch — LIMBO entre por tempo (encerrado) e por esgotamento', () => {
  // L1 esgotado; L2 por tempo iniciou, ENCERROU sem esgotar (sobra estoque); L3 por
  // esgotamento (não abre, pois L2 não esgotou). O ingresso fica ESGOTADO — mas um
  // cancelamento do L1 deve reabri-lo no L1.
  function limboBatches(l1Available: number) {
    return [
      batch({
        id: 'l1',
        sortOrder: 0,
        startDate: new Date('2030-01-01T00:00:00.000Z'),
        endDate: new Date('2030-02-01T00:00:00.000Z'), // encerrado
        quantity: 5,
        quantitySold: 5,
        availableQuantity: l1Available,
      }),
      batch({
        id: 'l2',
        sortOrder: 1,
        startDate: new Date('2030-02-01T00:00:00.000Z'),
        endDate: new Date('2030-03-01T00:00:00.000Z'), // encerrado
        quantity: 5,
        quantitySold: 2, // NÃO esgotou
        availableQuantity: 3, // sobra estoque, mas janela acabou
      }),
      batch({ id: 'l3', sortOrder: 2, triggerType: 'AFTER_PREVIOUS_SOLD_OUT', quantity: 5, availableQuantity: 5 }),
    ];
  }
  const now = new Date('2030-03-15T00:00:00.000Z'); // após a janela do L2

  it('sem cancelamento: ingresso ESGOTADO (L2 não esgotou + janela acabou → L3 não abre)', () => {
    const r = resolveActiveBatch(limboBatches(0), now);
    // O L2 (ativo) tem estoque sobrando mas a janela encerrou → NÃO vende; L3 não abre.
    expect(r.status).toBe('SOLD_OUT');
  });

  it('cancelamento do L1 devolve o assento → ingresso volta à venda no L1', () => {
    const r = resolveActiveBatch(limboBatches(1), now); // L1 recebeu 1 vaga de volta
    expect(r.batch.id).toBe('l1');
    expect(r.status).toBe('AVAILABLE');
  });
});

describe('resolveActiveBatch — progressão SEQUENCIAL (respeita a ordem dos lotes)', () => {
  it('BUG: L1 esgota mas L2 (por tempo) NÃO iniciou → NÃO pode abrir o L3 (por esgotamento)', () => {
    const l1 = batch({ id: 'l1', sortOrder: 0, quantity: 5, quantitySold: 5, availableQuantity: 0 }); // esgotado
    const l2 = batch({
      id: 'l2',
      sortOrder: 1,
      startDate: new Date('2030-05-01T12:00:00.000Z'), // futuro (não iniciou)
      quantity: 5,
      availableQuantity: 5,
    });
    const l3 = batch({ id: 'l3', sortOrder: 2, triggerType: 'AFTER_PREVIOUS_SOLD_OUT', quantity: 5, availableQuantity: 5 });
    const now = new Date('2030-03-01T12:00:00.000Z'); // antes de L2 iniciar
    const r = resolveActiveBatch([l1, l2, l3], now);
    // Trava no L1 (esgotado): L2 ainda não abriu → L3 NÃO abre. Ingresso aguarda L2.
    expect(r.batch.id).toBe('l1');
    expect(r.status).toBe('SOLD_OUT');
  });

  it('quando o tempo do L2 chega (com vaga), ele vira o ativo — não pula pro L3', () => {
    const l1 = batch({ id: 'l1', sortOrder: 0, quantity: 5, quantitySold: 5, availableQuantity: 0 });
    const l2 = batch({
      id: 'l2',
      sortOrder: 1,
      startDate: new Date('2030-03-01T06:00:00.000Z'), // inst 09:00Z
      quantity: 5,
      availableQuantity: 5,
    });
    const l3 = batch({ id: 'l3', sortOrder: 2, triggerType: 'AFTER_PREVIOUS_SOLD_OUT', quantity: 5, availableQuantity: 5 });
    const now = new Date('2030-03-01T15:00:00.000Z'); // após L2 abrir
    const r = resolveActiveBatch([l1, l2, l3], now);
    expect(r.batch.id).toBe('l2');
    expect(r.status).toBe('AVAILABLE');
  });

  it('L3 (por esgotamento) só abre depois do L2 (por tempo) iniciar E esgotar', () => {
    const l1 = batch({ id: 'l1', sortOrder: 0, quantity: 5, quantitySold: 5, availableQuantity: 0 });
    const l2 = batch({
      id: 'l2',
      sortOrder: 1,
      startDate: new Date('2030-03-01T06:00:00.000Z'), // já iniciou
      quantity: 5,
      quantitySold: 5, // esgotou
      availableQuantity: 0,
    });
    const l3 = batch({ id: 'l3', sortOrder: 2, triggerType: 'AFTER_PREVIOUS_SOLD_OUT', quantity: 5, availableQuantity: 5 });
    const now = new Date('2030-03-01T15:00:00.000Z');
    const r = resolveActiveBatch([l1, l2, l3], now);
    expect(r.batch.id).toBe('l3');
    expect(r.status).toBe('AVAILABLE');
  });
});
