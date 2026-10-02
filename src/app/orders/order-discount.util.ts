import { parseAppliesToArray } from '../../helpers/AppliesToHelper';

/**
 * Funções PURAS de distribuição de desconto por unidade de ingresso. Extraídas do
 * `orders.service` (2026-07-07) para poderem ser reusadas fora do módulo de pedidos
 * (ex.: export de inscrições) SEM puxar o módulo inteiro (evita ciclo de import).
 * `orders.service` re-exporta ambas, então os imports/tests existentes seguem iguais.
 */

/**
 * Expande reservedTickets em entradas individuais (quantity: 1 cada) e distribui
 * o desconto do cupom apenas nas unidades cobertas pelo effectiveUsage.
 * Sempre retorna uma entrada por ingresso, permitindo ao frontend identificar
 * exatamente quais receberam desconto.
 */
export function distributeDiscount(
  reservedTickets: any[],
  totalDiscount: number,
  effectiveUsage?: number,
  fixedPerUnit?: number,
  qualifyingSlots?: number[],
  appliesTo?: string | null,
  slotProducts?: number[],
): any[] {
  // Expand all tickets into individual unit slots
  const units: { rt: any; discount: number; productsDiscount: number }[] = [];
  for (const rt of reservedTickets) {
    for (let i = 0; i < rt.quantity; i++) {
      units.push({ rt, discount: 0, productsDiscount: 0 });
    }
  }
  // Base do slot = ingresso + produtos DO PARTICIPANTE do slot (`slotProducts`, só quando o
  // cupom/voucher cobre produtos). Sem isso a parte dos produtos caía nos ingressos, rateada
  // pelo preço (ia pro ingresso mais caro) e capada no unitPrice (o excedente sumia).
  const base = (i: number) => units[i].rt.unitPrice + (slotProducts?.[i] ?? 0);
  // Divide o desconto do slot entre o ingresso e os produtos dele, proporcional ao valor.
  const assign = (i: number, slotDiscount: number) => {
    const b = base(i);
    const ticket = b > 0 ? Math.min(units[i].rt.unitPrice, Math.round(slotDiscount * (units[i].rt.unitPrice / b))) : 0;
    units[i].discount = ticket;
    units[i].productsDiscount = slotDiscount - ticket;
  };

  if (!units.length) return [];

  const totalQuantity = units.length;
  // Só unidades dos ingressos do `appliesTo` recebem desconto. Sem isso, um ingresso FORA
  // do cupom mais caro que os vinculados levava o desconto (ordem por preço).
  const allowed = appliesTo && appliesTo !== 'all' ? new Set(parseAppliesToArray(appliesTo)) : null;
  const eligible = [...units.keys()].filter(i => !allowed || allowed.has(units[i].rt.ticketId));
  const coveredQty = Math.min(effectiveUsage ?? eligible.length, eligible.length);

  if (totalDiscount > 0 && coveredQty > 0) {
    let sorted: number[];
    if (qualifyingSlots && qualifyingSlots.length > 0) {
      // Apply discount to specific participant positions first, then fill by price if needed
      const validSlots = qualifyingSlots.filter(i => i >= 0 && i < totalQuantity);
      if (validSlots.length >= coveredQty) {
        sorted = validSlots.slice(0, coveredQty);
      } else {
        const byPrice = eligible
          .filter(i => !validSlots.includes(i))
          .sort((a, b) => units[b].rt.unitPrice - units[a].rt.unitPrice);
        sorted = [...validSlots, ...byPrice].slice(0, coveredQty);
      }
    } else {
      sorted = [...eligible].sort((a, b) => units[b].rt.unitPrice - units[a].rt.unitPrice);
    }

    if (fixedPerUnit !== undefined && fixedPerUnit > 0) {
      // FIXED: clampa o desconto por slot em unitPrice (evita finalUnitPrice negativo
      // quando o cupom é maior que o preço do ingresso — ex.: cupom FIXED grande com
      // applyToProducts=true cobrindo também produtos adicionais).
      for (let i = 0; i < coveredQty; i++) {
        const slotIdx = sorted[i];
        // FIXED: ingresso primeiro; o que passa do unitPrice vai para os produtos do slot.
        const slotDiscount = Math.min(fixedPerUnit, base(slotIdx));
        units[slotIdx].discount = Math.min(slotDiscount, units[slotIdx].rt.unitPrice);
        units[slotIdx].productsDiscount = slotDiscount - units[slotIdx].discount;
      }
    } else {
      // PERCENTAGE: distribui totalDiscount proporcional à base (ingresso + produtos do slot)
      // entre os slots cobertos. Sem `slotProducts` a base é só o ingresso e o excedente
      // (produtos) fica implícito em order.discount (finalAmount segue correto pelo agregado).
      const coveredBase = sorted.slice(0, coveredQty).reduce((s, i) => s + base(i), 0);
      const portion = Math.min(totalDiscount, coveredBase);
      let distrib = 0;
      for (let i = 0; i < coveredQty; i++) {
        const isLast = i === coveredQty - 1;
        const slotIdx = sorted[i];
        let allocated = isLast
          ? portion - distrib
          : coveredBase > 0
            ? Math.round(portion * (base(slotIdx) / coveredBase))
            : 0;
        allocated = Math.min(allocated, base(slotIdx));
        assign(slotIdx, allocated);
        distrib += allocated;
      }
    }
  }

  return units.map(({ rt, discount, productsDiscount }) => ({
    ...rt,
    quantity: 1,
    unitDiscount: discount,
    totalDiscount: discount,
    productsDiscount,
    couponApplied: discount + productsDiscount > 0,
    finalUnitPrice: rt.unitPrice - discount,
    finalTotalPrice: rt.unitPrice - discount,
  }));
}

/**
 * Cupom QUANTITY vale só DENTRO da faixa [minQuantity, maxQuantity] (ambos inclusivos;
 * null = sem limite naquele lado). Acima do máximo o cupom NÃO aplica — não é teto de
 * unidades descontadas. `qty` = unidades dos ingressos vinculados (appliesTo).
 */
export function isQuantityInCouponRange(
  qty: number,
  coupon: { minQuantity?: number | null; maxQuantity?: number | null },
): boolean {
  if (coupon.minQuantity != null && qty < coupon.minQuantity) return false;
  if (coupon.maxQuantity != null && qty > coupon.maxQuantity) return false;
  return true;
}

/**
 * Ordem de preferência entre cupons AUTOMÁTICOS elegíveis (regra de 2026-09-30): vale o
 * que MAIS desconta; empate → o já aplicado no pedido (`currentCouponId`); persistindo o
 * empate, mantém a ordem recebida (createdAt asc = o 1º criado). Não muta a entrada.
 * O pay percorre essa ordem até um cupom conseguir reservar uso (esgotado → próximo).
 */
export function rankAutoCouponCandidates<T extends { coupon: { id: string }; discount: number }>(
  candidates: T[],
  currentCouponId?: string | null,
): T[] {
  return candidates
    .map((c, index) => ({ c, index }))
    .sort((a, b) => {
      if (b.c.discount !== a.c.discount) return b.c.discount - a.c.discount;
      const aCur = a.c.coupon.id === currentCouponId ? 1 : 0;
      const bCur = b.c.coupon.id === currentCouponId ? 1 : 0;
      if (aCur !== bCur) return bCur - aCur;
      return a.index - b.index;
    })
    .map(({ c }) => c);
}

/**
 * Desconto de cupom QUANTITY (all-or-nothing) — FONTE ÚNICA usada pelo caminho de
 * exibição (`evaluateAndApplyAutoCoupons` / `orderShape`) E pela cobrança (`pay`), para
 * que os dois NUNCA divirjam (regressão histórica: display escopava por `appliesTo`, o
 * pay descontava sobre o carrinho inteiro).
 *
 * O desconto incide APENAS sobre `applicableTickets` — que já vêm filtrados por
 * `coupon.appliesTo` pelo caller. Nunca sobre ingressos fora da restrição.
 *
 * @param applicableTickets      reservedTickets já restritos ao `coupon.appliesTo`
 * @param ticketsSubtotal        subtotal de TODOS os ingressos do pedido (base do rateio
 *                               proporcional de produtos no caso PERCENTAGE)
 * @param productsContribution   `productsSubtotal` quando `applyToProducts`, senão 0
 * @param coupon                 tipo (PERCENTAGE/FIXED) e valor do cupom
 */
export function computeQuantityCouponDiscount(
  applicableTickets: any[],
  ticketsSubtotal: number,
  productsContribution: number,
  coupon: { type: string; value: number },
): number {
  const applicableSubtotal = applicableTickets.reduce(
    (s, rt) => s + rt.unitPrice * rt.quantity,
    0,
  );
  const applicableQty = applicableTickets.reduce((s, rt) => s + rt.quantity, 0);

  let discount: number;
  if (coupon.type === 'PERCENTAGE') {
    // Produtos entram rateados pela fração aplicável do subtotal de ingressos, mantendo a
    // base coerente quando o cupom cobre só parte do carrinho.
    const applicableRatio = ticketsSubtotal > 0 ? applicableSubtotal / ticketsSubtotal : 1;
    const applicableBase = applicableSubtotal + Math.round(productsContribution * applicableRatio);
    discount = Math.floor(applicableBase * (coupon.value / 100));
  } else {
    // FIXED: valor por unidade aplicável.
    discount = applicableQty * coupon.value;
  }
  // Nunca descontar mais do que a base efetivamente coberta.
  return Math.min(discount, applicableSubtotal + productsContribution);
}

/**
 * Acúmulo cupom automático + manual (regra 2026-10-02): cada cupom calcula sobre o preço
 * CHEIO e os descontos SOMAM por unidade, capados no preço — o ingresso chega a R$ 0 e para
 * de descontar, nunca fica negativo. Recebe as duas saídas de `distributeDiscount` (mesma
 * ordem de unidades). `overflow` = o que passou do preço (sai da parte do cupom manual).
 * `productsDiscount` soma; o teto dos produtos é o do pedido (preDiscountTotal).
 */
export function mergeStackedUnits(
  autoUnits: any[],
  manualUnits: any[],
): { units: any[]; overflow: number } {
  let overflow = 0;
  const units = manualUnits.map((m, i) => {
    const a = autoUnits[i] ?? { unitDiscount: 0, productsDiscount: 0 };
    const autoPart = Math.min(m.unitPrice, a.unitDiscount ?? 0);
    const manualPart = Math.min(m.unitPrice - autoPart, m.unitDiscount ?? 0);
    overflow += (m.unitDiscount ?? 0) - manualPart;
    const discount = autoPart + manualPart;
    const productsDiscount = (m.productsDiscount ?? 0) + (a.productsDiscount ?? 0);
    return {
      ...m,
      unitDiscount: discount,
      totalDiscount: discount,
      autoUnitDiscount: autoPart,
      productsDiscount,
      couponApplied: discount + productsDiscount > 0,
      finalUnitPrice: m.unitPrice - discount,
      finalTotalPrice: m.unitPrice - discount,
    };
  });
  return { units, overflow };
}

/**
 * Deduz o nº de unidades cobertas (`effectiveUsage`) a partir do desconto total
 * congelado num pedido PAGO — quando não há mais os slots/participantes p/ re-derivar.
 * Retorna `undefined` (cobre TODAS as unidades no distributeDiscount) quando não dá
 * pra inferir com segurança (voucher = cupom nulo, valor que não fecha, etc.).
 */
export function inferEffectiveUsage(
  reservedTickets: any[],
  coupon: { type: string; value: number; appliesTo?: string | null } | null | undefined,
  totalDiscount: number,
): number | undefined {
  if (!coupon || !totalDiscount || totalDiscount <= 0) return undefined;

  let applicable = reservedTickets;
  if (coupon.appliesTo && coupon.appliesTo !== 'all') {
    const allowed = parseAppliesToArray(coupon.appliesTo);
    applicable = reservedTickets.filter((rt) => allowed.includes(rt.ticketId));
  }

  const totalQty = applicable.reduce((s, rt) => s + rt.quantity, 0);
  if (totalQty === 0) return undefined;

  const units = applicable
    .flatMap((rt) => Array(rt.quantity).fill(rt.unitPrice))
    .sort((a: number, b: number) => b - a);

  if (coupon.type === 'PERCENTAGE') {
    for (let n = 1; n <= totalQty; n++) {
      const base = units.slice(0, n).reduce((s: number, p: number) => s + p, 0);
      const computed = Math.floor(base * (coupon.value / 100));
      if (computed === totalDiscount) return n;
      if (computed > totalDiscount) break;
    }
    return undefined;
  } else {
    if (coupon.value > 0 && totalDiscount % coupon.value === 0) {
      const n = totalDiscount / coupon.value;
      return n <= totalQty ? n : undefined;
    }
    return undefined;
  }
}
