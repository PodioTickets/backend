/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * FONTE ÚNICA DE VERDADE para a regra financeira de estorno/chargeback.
 *
 * Usada por: RepasseService (calcBreakdown/getSummary/getRefunded), EventsService
 * (getFinancial e listas) e PaymentsRefundService (audit log). Centralizar evita o
 * drift que causava bugs (cada view recalculando à sua maneira).
 */

/**
 * Taxa de refund PADRÃO (fallback). A taxa efetiva agora é POR EVENTO
 * (`Event.refundFeeRate`, snapshot na criação) — passada explicitamente a
 * `computeRefundImpact`. Esta constante é só o fallback para pedidos/eventos legados
 * sem a taxa resolvida. Incide sobre o subtotal (finalAmount − serviceFee, já com cupom),
 * em QUALQUER estorno — chargeback inclusive —, independente de método/auditoria/organizerFeePercent.
 */
export const REFUND_FEE_RATE = 0.02;

/**
 * Classificação ÚNICA de reversão — usada SÓ para SEPARAR/exibir (não muda a taxa).
 * Chargeback = reversão involuntária detectada pelo cron (`PaymentsChargebackService`),
 * grava `refundType: 'CHARGEBACK'`. Estorno proativo via admin grava `refundType: 'REFUND'`.
 * Legados sem o campo são tratados como REFUND (convenção do projeto).
 */
export function isChargeback(metadata: any): boolean {
  return (metadata?.refundType ?? null) === 'CHARGEBACK';
}

/**
 * % do organizador EFETIVO de um pedido: prioriza o snapshot congelado no pagamento
 * (`order.organizerFeePercent`, gravado no `pay`) e cai para o valor vivo do evento
 * (`eventOrganizerFeePercent`) em pedidos legados (snapshot null). Centraliza a regra de
 * fallback usada por repasse/refund — garante que o cálculo use a alíquota que de fato
 * vigorava na venda, não a config atual (que pode ter mudado).
 */
export function resolveOrderOrganizerFeePercent(
  order: any,
  eventOrganizerFeePercent: number,
): number {
  return order?.organizerFeePercent ?? eventOrganizerFeePercent;
}

/**
 * Impacto financeiro de um pedido estornado PARA O ORGANIZADOR.
 * Prioriza valores congelados em `payment.metadata` no momento do estorno; senão recalcula
 * com a alíquota EFETIVA do pedido (snapshot do pagamento, com fallback ao vivo via
 * `resolveOrderOrganizerFeePercent`) — verdade histórica mesmo que o evento mude depois.
 *
 *   organizerNetReversed — orgNet que o organizador DEIXA de receber (venda revertida).
 *   refundFee            — taxa de refund DEBITADA do saldo. Vale para refund E chargeback.
 *
 * @param refundFeeRate — taxa de estorno do EVENTO (fração 0–1). Default: REFUND_FEE_RATE
 *   (fallback para chamadas legadas sem a taxa). Só é usada quando NÃO há valor congelado.
 */
export function computeRefundImpact(
  order: any,
  organizerFeePercent: number,
  refundFeeRate: number = REFUND_FEE_RATE,
): { subtotal: number; organizerNetReversed: number; refundFee: number } {
  const meta = (order.payment?.metadata ?? {}) as any;
  const subtotal = Math.max(0, (order.finalAmount ?? 0) - (order.serviceFee ?? 0));

  const effectivePercent = resolveOrderOrganizerFeePercent(order, organizerFeePercent);
  const organizerNetReversed =
    typeof meta.organizerNetReversed === 'number'
      ? meta.organizerNetReversed
      : Math.round(subtotal * (1 - effectivePercent / 100));

  // Taxa de estorno sobre o subtotal. Prioriza o valor CONGELADO no estorno (verdade
  // histórica); senão recalcula com a taxa do evento (fallback à constante p/ legado).
  const rate = Number.isFinite(refundFeeRate) ? refundFeeRate : REFUND_FEE_RATE;
  const refundFee =
    typeof meta.refundFee === 'number'
      ? meta.refundFee
      : Math.round(subtotal * rate);

  return { subtotal, organizerNetReversed, refundFee };
}
