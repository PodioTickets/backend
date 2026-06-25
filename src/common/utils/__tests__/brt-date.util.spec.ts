import { brtDayStartUtc, brtDayEndUtc } from '../brt-date.util';

describe('brt-date.util (fronteiras de dia BRT em UTC)', () => {
  it('início do dia BRT = 03:00:00Z do mesmo dia (UTC-3)', () => {
    expect(brtDayStartUtc('2026-06-15').toISOString()).toBe('2026-06-15T03:00:00.000Z');
  });

  it('fim INCLUSIVO do dia BRT = 02:59:59.999Z do dia seguinte', () => {
    expect(brtDayEndUtc('2026-06-15').toISOString()).toBe('2026-06-16T02:59:59.999Z');
  });

  it('aceita ISO completo — usa só a parte da data (robusto ao fuso do remetente)', () => {
    // BRT user: meia-noite local de 15/06 chega como 03:00Z → parte da data 2026-06-15.
    expect(brtDayStartUtc('2026-06-15T03:00:00.000Z').toISOString()).toBe('2026-06-15T03:00:00.000Z');
    // Mesmo dia civil independentemente da hora no ISO.
    expect(brtDayEndUtc('2026-06-15T20:30:00.000Z').toISOString()).toBe('2026-06-16T02:59:59.999Z');
  });

  it('compra das 22h BRT (= 01:00Z do dia seguinte) cai DENTRO do dia BRT selecionado', () => {
    // Compra 2026-06-15 22:00 BRT = 2026-06-16T01:00:00Z.
    const purchase = new Date('2026-06-16T01:00:00.000Z');
    const start = brtDayStartUtc('2026-06-15');
    const end = brtDayEndUtc('2026-06-15');
    expect(purchase >= start && purchase <= end).toBe(true);
  });

  it('compra das 00:30 BRT do dia 16 (= 03:30Z dia 16) fica FORA do dia 15', () => {
    const purchase = new Date('2026-06-16T03:30:00.000Z'); // 00:30 BRT do dia 16
    expect(purchase <= brtDayEndUtc('2026-06-15')).toBe(false);
  });

  it('aceita objeto Date (usa a parte da data do ISO)', () => {
    expect(brtDayStartUtc(new Date('2026-01-02T10:00:00.000Z')).toISOString()).toBe('2026-01-02T03:00:00.000Z');
  });
});
