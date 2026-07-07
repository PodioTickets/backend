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
 * FALLBACK (lote por tempo encerrou e o fluxo natural travou): anda PARA TRÁS a
 * partir do lote encerrado e, se achar um lote POR ESGOTAMENTO que já havia aberto
 * e ainda tem vaga, esse volta a ser o ativo até esgotar. Só depois dele esgotar é
 * que o próximo por esgotamento é liberado. Sem candidato elegível → ingresso
 * ESGOTADO (não há transição válida).
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

  // 1) Progressão natural pela ordem: acha o lote mais avançado que já "abriu".
  //    Marca em `opened` cada lote que chegou a ser ativo — usado no fallback pra
  //    só reativar um lote por esgotamento que REALMENTE abriu (predecessor esgotou),
  //    nunca um que jamais foi liberado.
  let activeIdx = 0;
  const opened = new Set<number>([0]);

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[activeIdx];
    const curr = sorted[i];

    if (curr.triggerType === EXHAUST) {
      // Abre só quando o lote ativo anterior VENDEU tudo (pagamento confirmado).
      // Reservas pendentes não contam: ao expirarem, availableQuantity sobe e o
      // lote anterior reaparece disponível.
      if (prev.quantitySold >= prev.quantity) {
        activeIdx = i;
        opened.add(i);
      }
    } else if (isStartReached(curr, now)) {
      // BY_TIME: abre no instante real em BRT (wall-clock +3h) da startDate.
      activeIdx = i;
      opened.add(i);
    }
  }

  const active = sorted[activeIdx];

  // 2) Se o lote ativo é POR TEMPO e a janela ENCERROU, ele não vale mais mesmo
  //    com estoque. Tenta o fallback: lote por esgotamento anterior, já aberto e
  //    com vaga, começando pelo mais recente.
  if (isTimeWindowEnded(active, now)) {
    for (let j = activeIdx - 1; j >= 0; j--) {
      const b = sorted[j];
      if (opened.has(j) && b.triggerType === EXHAUST && b.availableQuantity > 0) {
        return { batch: b, batchNumber: j + 1, status: 'AVAILABLE' };
      }
    }
    // Nenhuma transição válida → encerrado/esgotado.
    return { batch: active, batchNumber: activeIdx + 1, status: 'SOLD_OUT' };
  }

  const status = active.availableQuantity > 0 ? 'AVAILABLE' : 'SOLD_OUT';
  return { batch: active, batchNumber: activeIdx + 1, status };
}
