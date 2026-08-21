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

/** Unidade com custo/líquido pré-computados (líquido = gross − custo). */
interface PricedUnit extends AnticipationUnit {
  cost: number;
  net: number;
}

function priceUnits(units: AnticipationUnit[], monthlyRate: number): PricedUnit[] {
  return units.map((u) => {
    const cost = unitCost(u.gross, u.daysUntilRelease, monthlyRate);
    return { ...u, cost, net: u.gross - cost };
  });
}

/** Orçamento de OPERAÇÕES da DP (n × estados). Acima disso a DP ESCALA a resolução
 *  do líquido (near-ótimo, nunca subcobre) p/ manter tempo/memória limitados. */
const DP_OP_BUDGET = 20_000_000;
/** Até este nº de unidades, força bruta EXATA (2^n) — evita alocar arrays grandes. */
const BRUTE_MAX_N = 16;

/** Monta {ids,gross,cost} na ordem de entrada a partir de um predicado de escolha. */
function collectPicked(
  units: PricedUnit[],
  isPicked: (idx: number) => boolean,
): { ids: string[]; gross: number; cost: number } {
  const ids: string[] = [];
  let gross = 0;
  let cost = 0;
  for (let idx = 0; idx < units.length; idx++) {
    if (!isPicked(idx)) continue;
    ids.push(units[idx].unitId);
    gross += units[idx].gross;
    cost += units[idx].cost;
  }
  return { ids, gross, cost };
}

/**
 * NÚCLEO da otimização: dentre TODOS os recebíveis, escolhe o subconjunto que
 * minimiza o GROSS consumido com `líquido ≥ requestedNet` — ou seja, a MENOR taxa
 * efetiva para receber o valor pedido (a sobra acima do pedido vira taxa). Como
 * `gross = líquido + custo`, isso minimiza (sobra + custo) ao mesmo tempo. DESEMPATE:
 * menor `recommendedNet` (líquido do conjunto) = recomendado mais colado no valor
 * digitado. Consumo por unidades INTEIRAS → subset-sum (knapsack). Pressupõe
 * Σlíquido ≥ requestedNet.
 *  - n ≤ BRUTE_MAX_N → força bruta exata (2^n).
 *  - senão → DP 0/1 (menor gross por estado de líquido), escalando a resolução se
 *    n×requestedNet passar do orçamento (near-ótimo só nesse caso; nunca subcobre).
 */
function minGrossSubsetForNet(
  units: PricedUnit[],
  requestedNet: number,
): { ids: string[]; gross: number; cost: number } {
  if (requestedNet <= 0) return { ids: [], gross: 0, cost: 0 };
  return units.length <= BRUTE_MAX_N
    ? bruteMinGross(units, requestedNet)
    : dpMinGross(units, requestedNet);
}

/** Força bruta exata (2^n): menor (gross, depois líquido) com líquido ≥ X. */
function bruteMinGross(
  units: PricedUnit[],
  X: number,
): { ids: string[]; gross: number; cost: number } {
  const n = units.length;
  const limit = 1 << n;
  let bestGross = Number.POSITIVE_INFINITY;
  let bestNet = Number.POSITIVE_INFINITY;
  let bestMask = 0;
  for (let mask = 1; mask < limit; mask++) {
    let net = 0;
    let gross = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        net += units[i].net;
        gross += units[i].gross;
      }
    }
    if (net < X) continue;
    // Menor gross (menor taxa); empate → menor líquido (recomendado + perto de X).
    if (gross < bestGross || (gross === bestGross && net < bestNet)) {
      bestGross = gross;
      bestNet = net;
      bestMask = mask;
    }
  }
  return collectPicked(units, (idx) => (bestMask & (1 << idx)) !== 0);
}

/**
 * DP 0/1: menor gross para líquido ≥ X (estado capado em X), desempate por menor
 * líquido real. Para n grande a resolução do líquido é ESCALADA por `r` de modo que
 * n×estados ≤ DP_OP_BUDGET; o piso (floor) garante que o líquido REAL do conjunto
 * escolhido ≥ X (nunca subcobre), tornando-se near-ótimo só quando r > 1.
 */
function dpMinGross(
  units: PricedUnit[],
  X: number,
): { ids: string[]; gross: number; cost: number } {
  const n = units.length;
  const maxStates = Math.max(1, Math.floor(DP_OP_BUDGET / n));
  const r = Math.max(1, Math.ceil(X / maxStates));
  const R = Math.ceil(X / r); // alvo escalado (estados 0..R)
  const INF = Number.POSITIVE_INFINITY;
  const dpGross = new Float64Array(R + 1).fill(INF);
  const dpNet = new Float64Array(R + 1).fill(INF); // líquido REAL do caminho (desempate)
  const fromUnit = new Int32Array(R + 1).fill(-1);
  const fromPrev = new Int32Array(R + 1).fill(-1);
  dpGross[0] = 0;
  dpNet[0] = 0;

  for (let ui = 0; ui < n; ui++) {
    const g = units[ui].gross;
    const realNet = units[ui].net;
    const ns = Math.floor(realNet / r); // contribuição de líquido ESCALADA (piso)
    if (ns <= 0) continue; // some ~nada à cobertura → nunca compensa (só soma gross)
    for (let k = R; k >= 0; k--) {
      if (dpGross[k] === INF) continue;
      const nk = k + ns >= R ? R : k + ns;
      const cg = dpGross[k] + g;
      const cn = dpNet[k] + realNet;
      if (cg < dpGross[nk] || (cg === dpGross[nk] && cn < dpNet[nk])) {
        dpGross[nk] = cg;
        dpNet[nk] = cn;
        fromUnit[nk] = ui;
        fromPrev[nk] = k;
      }
    }
  }

  // Escala derrubou a cobertura (perdas de piso perto do total) → consome tudo
  // (Σlíquido ≥ X garante que cobrir tudo é válido). Raro.
  if (dpGross[R] === INF) return collectPicked(units, () => true);

  const picked = new Set<number>();
  let k = R;
  while (k > 0) {
    const ui = fromUnit[k];
    if (ui < 0) break;
    picked.add(ui);
    k = fromPrev[k];
  }
  return collectPicked(units, (idx) => picked.has(idx));
}

/**
 * Calcula a antecipação para RECEBER `requestedNet` (líquido) ao MENOR custo: dentre
 * TODOS os recebíveis, escolhe o subconjunto que minimiza o gross consumido com
 * líquido ≥ pedido (= menor taxa efetiva; a sobra acima do pedido vira taxa),
 * desempatando pelo recomendado mais perto do valor digitado. Consumo por unidades
 * INTEIRAS (subset-sum) — ver `minGrossSubsetForNet`.
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

  const priced = priceUnits(units, monthlyRate);

  const finalize = (
    ids: string[],
    cumGross: number,
    cumCost: number,
  ): AnticipationResult => {
    const recommendedNet = cumGross - cumCost;
    // Recebe o que pediu; se pediu mais do que o total possível, recebe o total.
    const receive = Math.max(0, Math.min(requestedNet, recommendedNet));
    const effectiveFee = cumGross - receive;
    const effectiveRatePct = cumGross > 0 ? (effectiveFee / cumGross) * 100 : 0;
    return {
      consumedUnitIds: ids,
      consumedGross: cumGross,
      realCost: cumCost,
      recommendedNet,
      receive,
      effectiveFee,
      effectiveRatePct,
    };
  };

  // Inalcançável mesmo consumindo tudo → consome tudo (recebe o líquido total).
  const totalNet = priced.reduce((s, u) => s + u.net, 0);
  if (totalNet < requestedNet) {
    const cumGross = priced.reduce((s, u) => s + u.gross, 0);
    const cumCost = priced.reduce((s, u) => s + u.cost, 0);
    return finalize(priced.map((u) => u.unitId), cumGross, cumCost);
  }

  // Otimização GLOBAL (subset-sum) sobre todos os recebíveis.
  const pick = minGrossSubsetForNet(priced, requestedNet);
  return finalize(pick.ids, pick.gross, pick.cost);
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
