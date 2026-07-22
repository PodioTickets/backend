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
 * Corte de `eventDate` equivalente a `isEventDatePast`, para uso em WHERE do banco:
 * um evento é exibido como COMPLETED sse `eventDate < pastEventDateCutoff()`.
 *
 * Derivação: `isEventDatePast` só depende do DIA de `eventDate` (o fim do dia BRT
 * daquele dia). O dia de HOJE em BRT nunca está no passado (seu fim > agora) e
 * qualquer dia anterior já está. Logo o predicado vira "dia de eventDate < dia de
 * hoje em BRT" — e, como `eventDate` é wall-clock gravado em UTC, isso é uma
 * comparação direta contra a meia-noite UTC do dia BRT corrente.
 *
 * Por que importa: o status COMPLETED é DERIVADO na leitura (não existe no banco —
 * ver `withPastEventsAsCompleted`). Filtrar por `status` cru devolvia zero
 * "Concluído" e devolvia concluídos dentro de "Publicado". Filtro e exibição
 * precisam usar a MESMA regra.
 */
export function pastEventDateCutoff(now: Date = new Date()): Date {
  const brtNow = new Date(now.getTime() - 3 * 60 * 60 * 1000); // wall-clock BRT
  return new Date(`${brtNow.toISOString().slice(0, 10)}T00:00:00.000Z`);
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
