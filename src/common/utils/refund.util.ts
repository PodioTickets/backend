/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * FONTE ÚNICA DE VERDADE para a regra financeira de estorno/chargeback.
 *
 * Usada por: RepasseService (calcBreakdown/getSummary/getRefunded), EventsService
 * (getFinancial e listas) e PaymentsRefundService (audit log). Centralizar evita o
 * drift que causava bugs (cada view recalculando à sua maneira).
 */

/**
 * Taxa de refund: percentual FIXO (não configurável) cobrado do organizador em QUALQUER
 * estorno — chargeback INCLUSIVE (também é um tipo de estorno). Incide sobre o subtotal
 * (finalAmount − serviceFee, já com cupom aplicado), independente do método/auditoria/
 * organizerFeePercent.
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
 * Impacto financeiro de um pedido estornado PARA O ORGANIZADOR.
 * Prioriza valores congelados em `payment.metadata` no momento do estorno (verdade
 * histórica — `organizerFeePercent` pode mudar depois); cai para o cálculo ao vivo em
 * estornos legados (sem os campos congelados).
 *
 *   organizerNetReversed — orgNet que o organizador DEIXA de receber (venda revertida).
 *   refundFee            — taxa de refund (2%) DEBITADA do saldo. Vale para refund E chargeback.
 */
export function computeRefundImpact(
  order: any,
  organizerFeePercent: number,
): { subtotal: number; organizerNetReversed: number; refundFee: number } {
  const meta = (order.payment?.metadata ?? {}) as any;
  const subtotal = Math.max(0, (order.finalAmount ?? 0) - (order.serviceFee ?? 0));

  const organizerNetReversed =
    typeof meta.organizerNetReversed === 'number'
      ? meta.organizerNetReversed
      : Math.round(subtotal * (1 - organizerFeePercent / 100));

  // 2% sobre o subtotal em qualquer estorno. Usa o valor congelado se houver, senão recalcula.
  const refundFee =
    typeof meta.refundFee === 'number'
      ? meta.refundFee
      : Math.round(subtotal * REFUND_FEE_RATE);

  return { subtotal, organizerNetReversed, refundFee };
}
