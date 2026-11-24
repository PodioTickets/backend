/**
 * Regra CANÔNICA de "lote ativo" de um ingresso — fonte ÚNICA usada na leitura de
 * ingressos (checkout/cards), na busca pública (filtro de preço) E na reserva
 * (`orders.reserve`). Ter um só resolvedor evita que a tela mostre um lote como
 * comprável e a reserva o rejeite (ou vice-versa).
 *
 * O lote ativo é sequencial (por `sortOrder`) e depende do `triggerType`:
 * - BY_TIME: abre NA DATA, mesmo que lotes anteriores ainda tenham vaga ou não
 *   tenham aberto (regra do usuário 2026-11-23). Só fica disponível DURANTE sua janela
 *   [startDate, endDate]; ao fim da janela é ENCERRADO, mesmo com vagas sobrando.
 * - AFTER_PREVIOUS_SOLD_OUT: abre quando o lote imediatamente anterior JÁ ABRIU e
 *   VENDEU tudo (pagamento confirmado; reservas pendentes não contam).
 * O ativo é o lote ABERTO de maior `sortOrder`.
 *
 * FALLBACK (lote ativo ESGOTADO ou com a janela ENCERRADA): anda PARA TRÁS a partir
 * do lote ativo e reabre o lote ANTERIOR mais recente que ainda é ELEGÍVEL e tem
 * vaga — por esgotamento se já havia aberto; por tempo se ainda está dentro da
 * janela. Cobre o estorno/cancelamento que devolve o assento ao lote de origem (o
 * ingresso volta à venda naquele lote) e o lote por tempo encerrado que retorna a
 * um lote por esgotamento anterior. Sem candidato elegível → ingresso ESGOTADO.
 *
 * Sempre use isto para saber o preço "a partir de" comprável — NUNCA considere um
 * lote isolado por `startDate <= now`, pois lotes já superados por um posterior
 * continuariam casando (bug do filtro de preço da busca).
 *
 * ⚠️ FUSO: `startDate`/`endDate` são WALL-CLOCK gravados como UTC (ex.: "09:30Z" =
 * 09:30 BRT pretendido). Para comparar com o tempo real (`now`), o boundary passa por
 * `eventWindowInstant` (+3h). Sem isso o lote abriria/fecharia 3h CEDO no Brasil — a
 * mesma regra da janela de inscrição (orders.reserve/registrations).
 */
import { eventWindowInstant } from '../../common/utils/brt-date.util';
export type BatchWithSold = {
  id: string;
  quantity: number;
  availableQuantity: number;
  price: number;
  startDate: Date | null;
  endDate: Date | null;
  sortOrder: number;
  triggerType: string;
  quantitySold: number;
};

const EXHAUST = 'AFTER_PREVIOUS_SOLD_OUT';

/** Lote POR TEMPO cuja janela JÁ FECHOU (now > endDate, em BRT). Esgotamento nunca "encerra" por data. */
function isTimeWindowEnded(b: BatchWithSold, now: Date): boolean {
  return b.triggerType !== EXHAUST && b.endDate != null && now > eventWindowInstant(b.endDate);
}

/** Lote POR TEMPO cuja janela já ABRIU (sem startDate = sempre aberto). */
function isStartReached(b: BatchWithSold, now: Date): boolean {
  return !b.startDate || now >= eventWindowInstant(b.startDate);
}

/**
 * `autoSoldOutAt` = esgotamento automático do INGRESSO (`Ticket.autoSoldOutAt`, wall-clock
 * como UTC): passado o instante (BRT), o ingresso fica ESGOTADO mesmo com vaga e sem
 * fallback. Mora aqui para valer igual na leitura, na reserva e na troca.
 */
export function resolveActiveBatch(
  batches: BatchWithSold[],
  now: Date,
  autoSoldOutAt?: Date | null,
): { batch: BatchWithSold; batchNumber: number; status: 'AVAILABLE' | 'SOLD_OUT' } {
  const sorted = [...batches].sort((a, b) => a.sortOrder - b.sortOrder);

  // 1) Quais lotes já ABRIRAM. Por tempo abre na própria data, independente dos
  //    anteriores — antes havia um `break` no 1º lote que não abria, e um lote por
  //    esgotamento no meio (anterior com vaga) travava o lote por data seguinte para
  //    sempre. Por esgotamento continua SEQUENCIAL: exige o anterior REAL (`i-1`)
  //    aberto e vendido — não pula um lote por tempo ainda não iniciado.
  const opened = sorted.map(() => false);
  opened[0] = true; // 1º lote é a base (antes da data ele é "não iniciado" na reserva)
  let activeIdx = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]; // lote IMEDIATAMENTE anterior (sortOrder)
    const curr = sorted[i];

    opened[i] =
      curr.triggerType === EXHAUST
        ? // Por esgotamento: só quando o anterior abriu e VENDEU tudo.
          opened[i - 1] && prev.quantitySold >= prev.quantity
        : // Por tempo: quando a janela do próprio lote já abriu (instante real BRT +3h).
          isStartReached(curr, now);

    if (opened[i]) activeIdx = i;
  }

  const active = sorted[activeIdx];

  if (autoSoldOutAt && now > eventWindowInstant(autoSoldOutAt)) {
    return { batch: active, batchNumber: activeIdx + 1, status: 'SOLD_OUT' };
  }

  // 2) Lote ativo VENDÁVEL (dentro da janela E com vaga) → segue ele.
  const activeSellable =
    !isTimeWindowEnded(active, now) && active.availableQuantity > 0;
  if (activeSellable) {
    return { batch: active, batchNumber: activeIdx + 1, status: 'AVAILABLE' };
  }

  // 3) Lote ativo NÃO vendável (ESGOTADO ou janela ENCERRADA) → reabre o lote
  //    ANTERIOR mais recente que TEM vaga (o assento foi DEVOLVIDO a ele por um
  //    estorno/cancelamento). Só lotes que JÁ ABRIRAM (`opened`) — um lote pulado (por
  //    esgotamento que nunca abriu, por tempo ainda futuro) não volta; dos abertos basta
  //    ter vaga, INDEPENDENTE do tipo ou de
  //    a janela por tempo já ter encerrado. É o caso do "limbo": lote por tempo passou
  //    sem esgotar e o próximo é por esgotamento (não abre) → um cancelamento do lote
  //    anterior faz o ingresso voltar à venda NAQUELE lote (decisão do usuário
  //    2026-07-07). Em fluxo normal os anteriores estão sem vaga → nada reabre.
  //    OBS: o próprio lote ATIVO com janela encerrada e estoque sobrando NÃO volta a
  //    vender (respeita "por tempo só durante a janela") — só um lote anterior que
  //    recebeu um assento de volta é reaberto.
  for (let j = activeIdx - 1; j >= 0; j--) {
    if (opened[j] && sorted[j].availableQuantity > 0) {
      return { batch: sorted[j], batchNumber: j + 1, status: 'AVAILABLE' };
    }
  }

  // Nenhuma transição válida → esgotado/encerrado.
  return { batch: active, batchNumber: activeIdx + 1, status: 'SOLD_OUT' };
}

/**
 * Lotes POR DATA (BY_TIME) com a MESMA janela (início e término iguais) no mesmo
 * ingresso — regra do usuário 2026-11-24: não pode. Lote "ao esgotar o anterior"
 * não tem janela própria e fica de fora. Compara o instante (data + hora).
 * @returns índices (0-based) do 1º par repetido, ou null.
 */
export function findDuplicateBatchPeriod(
  batches: Array<{ startDate?: string | Date | null; endDate?: string | Date | null; triggerType?: string | null }>,
): [number, number] | null {
  const seen = new Map<string, number>();
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    if (b.triggerType === 'AFTER_PREVIOUS_SOLD_OUT' || !b.startDate || !b.endDate) continue;
    const start = new Date(b.startDate).getTime();
    const end = new Date(b.endDate).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const key = `${start}|${end}`;
    const prev = seen.get(key);
    if (prev !== undefined) return [prev, i];
    seen.set(key, i);
  }
  return null;
}
