import { EventStatus } from '@prisma/client';
import {
  isEventDatePast,
  pastEventDateCutoff,
  withPastEventsAsCompleted,
} from '../event-status.util';

/**
 * Regra de "evento concluído" nas listagens (organizador + admin). `eventDate` é
 * wall-clock gravado como UTC; "concluído" só vale após o FIM DO DIA civil em BRT.
 */
describe('event-status.util (evento concluído por data, BRT)', () => {
  // Evento do dia 2026-07-01 às 20:00 (wall-clock) → gravado 2026-07-01T20:00:00Z.
  const eventDate = new Date('2026-07-01T20:00:00.000Z');

  it('NÃO concluído durante o dia do evento (mesmo após a hora do wall-clock)', () => {
    // 2026-07-01 21:00 BRT = 2026-07-02T00:00:00Z — ainda é o dia do evento em BRT.
    const now = new Date('2026-07-02T00:00:00.000Z');
    expect(isEventDatePast(eventDate, now)).toBe(false);
  });

  it('NÃO concluído no limiar do fim do dia BRT (23:59:59.999 BRT)', () => {
    // Fim do dia 01/07 BRT = 2026-07-02T02:59:59.999Z (inclusivo → ainda não passou).
    const now = new Date('2026-07-02T02:59:59.999Z');
    expect(isEventDatePast(eventDate, now)).toBe(false);
  });

  it('CONCLUÍDO logo após a virada do dia em BRT (00:00 BRT do dia seguinte)', () => {
    // 2026-07-02 00:00 BRT = 2026-07-02T03:00:00Z.
    const now = new Date('2026-07-02T03:00:00.000Z');
    expect(isEventDatePast(eventDate, now)).toBe(true);
  });

  it('regressão do bug das ~3h: evento de horário FUTURO no mesmo dia não é concluído', () => {
    // Evento às 20:00 BRT (= 23:00Z real). Agora são 18:00 BRT (= 21:00Z). A
    // comparação crua `eventDate(20:00Z) < now(21:00Z)` marcava concluído cedo.
    const now = new Date('2026-07-01T21:00:00.000Z'); // 18:00 BRT
    expect(isEventDatePast(eventDate, now)).toBe(false);
  });

  it('withPastEventsAsCompleted: só sobrescreve o status dos eventos com data passada', () => {
    const now = new Date('2026-07-02T03:00:00.000Z');
    const past = { eventDate, status: EventStatus.PUBLISHED };
    const future = {
      eventDate: new Date('2026-12-31T20:00:00.000Z'),
      status: EventStatus.PUBLISHED,
    };
    const out = withPastEventsAsCompleted([past, future], now);
    expect(out[0].status).toBe(EventStatus.COMPLETED);
    expect(out[1].status).toBe(EventStatus.PUBLISHED);
    // Não muta o original.
    expect(past.status).toBe(EventStatus.PUBLISHED);
  });

  /**
   * O filtro de status ("Concluído") roda no WHERE do banco via
   * `pastEventDateCutoff`, enquanto a EXIBIÇÃO usa `isEventDatePast`. Se as duas
   * divergirem, o filtro volta a mentir (era o bug: "Concluído" devolvia 0 e
   * "Publicado" trazia concluídos). Aqui o invariante é travado.
   */
  describe('pastEventDateCutoff ≡ isEventDatePast (filtro do banco == exibição)', () => {
    it('cutoff é a meia-noite UTC do dia BRT corrente', () => {
      // 2026-07-02 00:30 BRT = 2026-07-02T03:30:00Z → dia BRT corrente = 02/07.
      expect(pastEventDateCutoff(new Date('2026-07-02T03:30:00.000Z')).toISOString())
        .toBe('2026-07-02T00:00:00.000Z');
      // 2026-07-01 22:00 BRT = 2026-07-02T01:00:00Z → ainda é 01/07 em BRT.
      expect(pastEventDateCutoff(new Date('2026-07-02T01:00:00.000Z')).toISOString())
        .toBe('2026-07-01T00:00:00.000Z');
    });

    it('`eventDate < cutoff` concorda com isEventDatePast em toda a grade de horas', () => {
      const nows = [
        new Date('2026-07-01T21:00:00.000Z'), // 18:00 BRT do dia do evento
        new Date('2026-07-02T00:00:00.000Z'), // 21:00 BRT do dia do evento
        new Date('2026-07-02T02:59:59.999Z'), // último ms do dia BRT
        new Date('2026-07-02T03:00:00.000Z'), // 00:00 BRT do dia seguinte
        new Date('2026-07-05T12:00:00.000Z'), // dias depois
      ];
      for (const now of nows) {
        const cutoff = pastEventDateCutoff(now);
        for (let day = 1; day <= 4; day++) {
          for (const hour of ['00:00', '09:30', '20:00', '23:59']) {
            const d = new Date(`2026-07-0${day}T${hour}:00.000Z`);
            expect(d < cutoff).toBe(isEventDatePast(d, now));
          }
        }
      }
    });
  });
});
