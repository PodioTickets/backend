/**
 * Formatação dos cards de evento nos E-MAILS — espelha o card atual da home
 * (frontend `EventCard` / `datetimeBR.formatEventHappensLabel`). Fonte ÚNICA
 * (antes havia 4 cópias de formatEventDate/formatEventAddress espalhadas).
 */

const HAPPENS_OPTS: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC', // eventDate é WALL-CLOCK UTC → formata sem shift do fuso do servidor
};

/**
 * Data por extenso do card: "Sábado, 25 de julho" (dia da semana + dia + mês,
 * 1ª letra maiúscula), IDÊNTICA ao card do app (frontend `formatEventHappensLabel`).
 * `Intl` pt-BR devolve o dia da semana em minúsculo → capitalizamos. UTC (eventDate
 * é wall-clock). Retorna "" para data ausente/ inválida.
 */
export function formatEventHappensDate(
  date: Date | string | null | undefined,
): string {
  if (!date) return '';
  const d = new Date(date as string);
  if (isNaN(d.getTime())) return '';
  const label = new Intl.DateTimeFormat('pt-BR', HAPPENS_OPTS).format(d);
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : '';
}

/**
 * Fuso de Brasília. Usado para INSTANTES REAIS (analisado em / enviado em).
 * Em produção o servidor roda em UTC, então `getHours()` e um
 * `toLocaleDateString` sem `timeZone` cravam UTC e o e-mail mostra 3h a mais.
 * Mesmo tratamento já aplicado nos PDFs (`ticket-pdf.template.ts`).
 */
const TZ_BR = 'America/Sao_Paulo';

const EVENT_DATE_WEEKDAY_OPTS: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  timeZone: 'UTC', // eventDate é WALL-CLOCK UTC → sem shift do fuso do servidor
};

/**
 * Data curta do evento + dia da semana: "25/07/2026 · sábado".
 *
 * `eventDate` é wall-clock gravado como UTC — formatar em UTC é o que impede o
 * dia de recuar quando o servidor não está em UTC. Retorna "" para data inválida.
 */
export function formatEventDateWithWeekday(
  date: Date | string | null | undefined,
): string {
  if (!date) return '';
  const d = new Date(date as string);
  if (isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
  const weekday = new Intl.DateTimeFormat('pt-BR', EVENT_DATE_WEEKDAY_OPTS).format(d);
  return `${day} · ${weekday}`;
}

/**
 * Data + hora de um INSTANTE REAL no fuso de Brasília: "03/09/2026 · 14h32".
 * Use para "analisado em" / "enviado para análise em" — nunca para `eventDate`.
 */
export function formatBrtInstant(instant: Date): string {
  const date = instant.toLocaleDateString('pt-BR', { timeZone: TZ_BR });
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ_BR,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${date} · ${hh}h${mm}`;
}

/**
 * Endereço do card: "Local, Cidade, Estado" (`locationName` = nome do local
 * escolhido no mapa → cidade → estado), igual ao card da home. Campos vazios são
 * omitidos, então evento legado sem `locationName` cai para "Cidade, Estado".
 */
export function formatEventCardAddress(event: {
  locationName?: string | null;
  city?: string | null;
  state?: string | null;
}): string {
  return [event?.locationName, event?.city, event?.state]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(', ');
}
