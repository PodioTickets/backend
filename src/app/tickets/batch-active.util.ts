/**
 * Regra CANÔNICA de "lote ativo" de um ingresso — fonte ÚNICA usada na leitura de
 * ingressos (checkout/cards), na busca pública (filtro de preço) E na reserva
 * (`orders.reserve`). Ter um só resolvedor evita que a tela mostre um lote como
 * comprável e a reserva o rejeite (ou vice-versa).
 *
 * O lote ativo é sequencial (por `sortOrder`) e depende do `triggerType`:
 * - BY_TIME: só fica disponível DURANTE sua janela [startDate, endDate]. Ao fim da
 *   janela é ENCERRADO, mesmo com vagas sobrando.
 * - AFTER_PREVIOUS_SOLD_OUT: abre quando o lote imediatamente anterior VENDE tudo
 *   (pagamento confirmado; reservas pendentes não contam).
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

export function resolveActiveBatch(
  batches: BatchWithSold[],
  now: Date,
): { batch: BatchWithSold; batchNumber: number; status: 'AVAILABLE' | 'SOLD_OUT' } {
  const sorted = [...batches].sort((a, b) => a.sortOrder - b.sortOrder);

  // 1) Progressão SEQUENCIAL pela ordem: o lote `i` só abre se o lote IMEDIATAMENTE
  //    anterior (`i-1`) já abriu. Por isso PARAMOS (break) no primeiro lote que não
  //    pode abrir — nada depois dele pode estar ativo. Sem isso, um lote por
  //    esgotamento pulava um lote por tempo ainda não iniciado (checava a condição
  //    contra o lote ATIVO, não contra o anterior real) e abria fora de ordem.
  let activeIdx = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]; // lote IMEDIATAMENTE anterior (sortOrder)
    const curr = sorted[i];

    const canOpen =
      curr.triggerType === EXHAUST
        ? // Por esgotamento: só quando o anterior VENDEU tudo (pagamento confirmado;
          // reservas pendentes contam via availableQuantity, mas aqui é a contagem).
          prev.quantitySold >= prev.quantity
        : // Por tempo: quando a janela do próprio lote já abriu (instante real BRT +3h).
          isStartReached(curr, now);

    if (!canOpen) break; // sequência travada aqui
    activeIdx = i;
  }

  const active = sorted[activeIdx];

  // 2) Lote ativo VENDÁVEL (dentro da janela E com vaga) → segue ele.
  const activeSellable =
    !isTimeWindowEnded(active, now) && active.availableQuantity > 0;
  if (activeSellable) {
    return { batch: active, batchNumber: activeIdx + 1, status: 'AVAILABLE' };
  }

  // 3) Lote ativo NÃO vendável (ESGOTADO ou janela ENCERRADA) → reabre o lote
  //    ANTERIOR mais recente que TEM vaga (o assento foi DEVOLVIDO a ele por um
  //    estorno/cancelamento). Como a progressão é sequencial com break, os lotes
  //    `0..activeIdx-1` já ABRIRAM — então basta ter vaga, INDEPENDENTE do tipo ou de
  //    a janela por tempo já ter encerrado. É o caso do "limbo": lote por tempo passou
  //    sem esgotar e o próximo é por esgotamento (não abre) → um cancelamento do lote
  //    anterior faz o ingresso voltar à venda NAQUELE lote (decisão do usuário
  //    2026-07-07). Em fluxo normal os anteriores estão sem vaga → nada reabre.
  //    OBS: o próprio lote ATIVO com janela encerrada e estoque sobrando NÃO volta a
  //    vender (respeita "por tempo só durante a janela") — só um lote anterior que
  //    recebeu um assento de volta é reaberto.
  for (let j = activeIdx - 1; j >= 0; j--) {
    if (sorted[j].availableQuantity > 0) {
      return { batch: sorted[j], batchNumber: j + 1, status: 'AVAILABLE' };
    }
  }

  // Nenhuma transição válida → esgotado/encerrado.
  return { batch: active, batchNumber: activeIdx + 1, status: 'SOLD_OUT' };
}
