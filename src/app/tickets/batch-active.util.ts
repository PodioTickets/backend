/**
 * Regra CANÔNICA de "lote ativo" de um ingresso — fonte única usada tanto na
 * leitura de ingressos (checkout/cards) quanto na busca pública (filtro de preço).
 *
 * O lote ativo é sequencial (por `sortOrder`) e depende do `triggerType`:
 * - BY_TIME: abre quando `startDate` chega (`now >= startDate`).
 * - AFTER_PREVIOUS_SOLD_OUT: abre quando o lote anterior VENDE tudo (pagamento
 *   confirmado; reservas pendentes não contam).
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

export function resolveActiveBatch(
  batches: BatchWithSold[],
  now: Date,
): { batch: BatchWithSold; batchNumber: number; status: 'AVAILABLE' | 'SOLD_OUT' } {
  const sorted = [...batches].sort((a, b) => a.sortOrder - b.sortOrder);

  let activeIdx = 0;

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[activeIdx];
    const curr = sorted[i];

    if (curr.triggerType === 'AFTER_PREVIOUS_SOLD_OUT') {
      // Abre somente quando todas as vagas do lote anterior foram VENDIDAS (pagamento confirmado)
      // Reservas pendentes não contam — quando expirarem, availableQuantity sobe e o lote anterior reaparece disponível
      if (prev.quantitySold >= prev.quantity) {
        activeIdx = i;
      }
    } else {
      // BY_TIME: abre SOMENTE quando startDate for definida e o INSTANTE REAL em BRT
      // (wall-clock +3h) já tiver chegado.
      if (curr.startDate && now >= eventWindowInstant(curr.startDate)) {
        activeIdx = i;
      }
    }
  }

  const batch = sorted[activeIdx];
  const status = batch.availableQuantity > 0 ? 'AVAILABLE' : 'SOLD_OUT';
  return { batch, batchNumber: activeIdx + 1, status };
}
