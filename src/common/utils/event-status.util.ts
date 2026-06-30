import { EventStatus } from '@prisma/client';
import { brtDayEndUtc } from './brt-date.util';

/**
 * Regra de exibição "evento CONCLUÍDO" para LISTAGENS (organizador e admin —
 * MESMA fonte de verdade).
 *
 * Um evento é exibido como COMPLETED somente depois que a DATA do evento passou,
 * usando o fim do dia civil em BRT (`brtDayEndUtc`). O `eventDate` é wall-clock
 * gravado como UTC; comparar o valor cru com `new Date()` adiantava ~3h e marcava
 * um evento do próprio dia (ou de horário ainda futuro) como concluído. Comparar
 * contra o fim do dia BRT alinha com "a data do evento ainda não passou".
 */
export function isEventDatePast(eventDate: Date, now: Date = new Date()): boolean {
  return brtDayEndUtc(eventDate).getTime() < now.getTime();
}

/**
 * Mapeia uma lista de eventos sobrescrevendo o status para COMPLETED quando a data
 * já passou (ver `isEventDatePast`). Não muta os itens originais.
 */
export function withPastEventsAsCompleted<
  T extends { eventDate: Date; status: EventStatus },
>(events: T[], now: Date = new Date()): T[] {
  return events.map((e) =>
    isEventDatePast(e.eventDate, now) ? { ...e, status: EventStatus.COMPLETED } : e,
  ) as T[];
}
