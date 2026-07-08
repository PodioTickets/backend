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
 * Data por extenso do card: "na sexta-feira, 31 de julho" (preposição + dia da
 * semana + dia + mês). A preposição concorda com o gênero do dia (domingo/sábado
 * → "no"; segunda a sexta …-feira → "na"), igual ao card da home. O prefixo
 * "Acontece" fica no template. Retorna "" para data ausente/ inválida.
 */
export function formatEventHappensDate(
  date: Date | string | null | undefined,
): string {
  if (!date) return '';
  const d = new Date(date as string);
  if (isNaN(d.getTime())) return '';
  const weekday = d.getUTCDay(); // 0=domingo … 6=sábado
  const prep = weekday === 0 || weekday === 6 ? 'no' : 'na';
  return `${prep} ${new Intl.DateTimeFormat('pt-BR', HAPPENS_OPTS).format(d)}`;
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
