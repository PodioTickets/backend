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
