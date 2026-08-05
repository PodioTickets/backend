/**
 * Motor de ANTECIPAÇÃO DE RECEBÍVEIS (conforme `frontend/adiantamento.md`).
 *
 * Modelo de UNIDADES: cada recebível antecipável é uma "unidade" — um pedido à
 * vista (parcela 1x) ou UMA parcela pendente de um parcelado. Todas entram no
 * MESMO bolo. Consumimos as unidades MAIS BARATAS primeiro (as mais próximas de
 * vencer → menos dias antecipados → menor custo), o que dá a MENOR taxa efetiva
 * ao organizador.
 *
 * Custo por unidade (fórmula do doc):
 *   custo_i = round(gross_i × taxaMensal × dias_i / 30)
 *   liquido_i = gross_i − custo_i
 *
 * Consumo é por UNIDADES INTEIRAS (não fraciona parcela/pedido). Como o valor
 * pedido raramente cai exatamente numa fronteira de unidade, o "valor
 * recomendado" é o líquido acumulado das unidades inteiras necessárias para
 * cobrir o pedido — antecipar exatamente esse valor evita que a sobra vire taxa.
 *
 * `requestedNet` = quanto o organizador quer RECEBER hoje (líquido). Se ele pede
 * ABAIXO da fronteira (recommendedNet), as mesmas unidades inteiras são
 * consumidas e a diferença (recommendedNet − requestedNet) vira taxa extra da
 * plataforma → a taxa efetiva sobe (é o incentivo pro "valor recomendado").
 *
 * Determinístico e puro (sem I/O) → o backend usa como VERDADE (recálculo no
 * request) e o front espelha a mesma conta na prévia ao vivo.
 */

export interface AnticipationUnit {
  /** ID estável da unidade: à vista = orderId; parcela = `${paymentId}-inst-${n}`. */
  unitId: string;
  orderId: string;
  paymentId: string;
  /** Nº da parcela (1..total) ou null p/ à vista (tratada como parcela 1x). */
  installmentNumber: number | null;
  /** Valor líquido-do-organizador desta unidade, em centavos (base do custo). */
  gross: number;
  /** Dias até a liberação natural (= dias antecipados se anteciparmos agora). */
  daysUntilRelease: number;
}

export interface AnticipationResult {
  /** Unidades (ids) efetivamente consumidas para cobrir o pedido. */
  consumedUnitIds: string[];
  /** Soma bruta (gross) das unidades consumidas — a base da taxa efetiva. */
  consumedGross: number;
  /** Custo REAL (fórmula) das unidades consumidas, sem a sobra. */
  realCost: number;
  /** Líquido das unidades inteiras (fronteira) = o "valor recomendado". */
  recommendedNet: number;
  /** Quanto o organizador recebe hoje (= requestedNet clampeado ao possível). */
  receive: number;
  /** Taxa efetiva cobrada: consumedGross − receive (inclui a sobra). */
  effectiveFee: number;
  /** Taxa efetiva em %: effectiveFee / consumedGross × 100. */
  effectiveRatePct: number;
}

/** Custo (centavos) de antecipar UMA unidade agora. */
export function unitCost(gross: number, daysUntilRelease: number, monthlyRate: number): number {
  return Math.round(gross * monthlyRate * (daysUntilRelease / 30));
}

/** Soma bruta de todas as unidades — o "Valor disponível" (teto antecipável bruto). */
export function totalAvailableGross(units: AnticipationUnit[]): number {
  return units.reduce((s, u) => s + u.gross, 0);
}

/** Ordena as unidades do MAIS BARATO (menos dias) ao mais caro; desempata por gross. */
function sortCheapestFirst(units: AnticipationUnit[]): AnticipationUnit[] {
  return [...units].sort(
    (a, b) => a.daysUntilRelease - b.daysUntilRelease || a.gross - b.gross,
  );
}

/**
 * Calcula a antecipação para receber `requestedNet` (líquido) consumindo as
 * unidades mais baratas primeiro, por unidades INTEIRAS.
 */
export function computeAnticipation(
  units: AnticipationUnit[],
  requestedNet: number,
  monthlyRate: number,
): AnticipationResult {
  const empty: AnticipationResult = {
    consumedUnitIds: [],
    consumedGross: 0,
    realCost: 0,
    recommendedNet: 0,
    receive: 0,
    effectiveFee: 0,
    effectiveRatePct: 0,
  };
  if (requestedNet <= 0 || units.length === 0) return empty;

  const sorted = sortCheapestFirst(units);
  let cumGross = 0;
  let cumCost = 0;
  const consumed: string[] = [];
  for (const u of sorted) {
    cumGross += u.gross;
    cumCost += unitCost(u.gross, u.daysUntilRelease, monthlyRate);
    consumed.push(u.unitId);
    // Para quando o LÍQUIDO acumulado já cobre o pedido (unidades inteiras).
    if (cumGross - cumCost >= requestedNet) break;
  }

  const recommendedNet = cumGross - cumCost;
  // Recebe o que pediu; se pediu mais do que o total possível, recebe o total.
  const receive = Math.max(0, Math.min(requestedNet, recommendedNet));
  const effectiveFee = cumGross - receive;
  const effectiveRatePct = cumGross > 0 ? (effectiveFee / cumGross) * 100 : 0;

  return {
    consumedUnitIds: consumed,
    consumedGross: cumGross,
    realCost: cumCost,
    recommendedNet,
    receive,
    effectiveFee,
    effectiveRatePct,
  };
}

/**
 * Dado um valor pedido (líquido), devolve o "valor recomendado" — o líquido das
 * unidades inteiras que o cobrem (a fronteira ≥ pedido). Se o pedido excede o
 * total possível, o recomendado é o líquido total.
 */
export function recommendedNetFor(
  units: AnticipationUnit[],
  requestedNet: number,
  monthlyRate: number,
): number {
  if (requestedNet <= 0 || units.length === 0) return 0;
  return computeAnticipation(units, requestedNet, monthlyRate).recommendedNet;
}
