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
): any[] {
  // Expand all tickets into individual unit slots
  const units: { rt: any; discount: number }[] = [];
  for (const rt of reservedTickets) {
    for (let i = 0; i < rt.quantity; i++) {
      units.push({ rt, discount: 0 });
    }
  }

  if (!units.length) return [];

  const totalQuantity = units.length;
  const coveredQty = Math.min(effectiveUsage ?? totalQuantity, totalQuantity);

  if (totalDiscount > 0 && coveredQty > 0) {
    let sorted: number[];
    if (qualifyingSlots && qualifyingSlots.length > 0) {
      // Apply discount to specific participant positions first, then fill by price if needed
      const validSlots = qualifyingSlots.filter(i => i >= 0 && i < totalQuantity);
      if (validSlots.length >= coveredQty) {
        sorted = validSlots.slice(0, coveredQty);
      } else {
        const byPrice = [...units.keys()]
          .filter(i => !validSlots.includes(i))
          .sort((a, b) => units[b].rt.unitPrice - units[a].rt.unitPrice);
        sorted = [...validSlots, ...byPrice].slice(0, coveredQty);
      }
    } else {
      sorted = [...units.keys()].sort((a, b) => units[b].rt.unitPrice - units[a].rt.unitPrice);
    }

    if (fixedPerUnit !== undefined && fixedPerUnit > 0) {
      // FIXED: clampa o desconto por slot em unitPrice (evita finalUnitPrice negativo
      // quando o cupom é maior que o preço do ingresso — ex.: cupom FIXED grande com
      // applyToProducts=true cobrindo também produtos adicionais).
      for (let i = 0; i < coveredQty; i++) {
        const slotIdx = sorted[i];
        units[slotIdx].discount = Math.min(fixedPerUnit, units[slotIdx].rt.unitPrice);
      }
    } else {
      // PERCENTAGE: distribui totalDiscount proporcional ao unitPrice entre os slots cobertos.
      // Quando totalDiscount > subtotal dos ingressos cobertos (cupom com applyToProducts=true),
      // só a porção que cabe nos ingressos é distribuída por slot — o excedente fica implícito
      // em order.discount (finalAmount segue correto via order.discount agregado).
      const coveredSubtotal = sorted.slice(0, coveredQty).reduce((s, i) => s + units[i].rt.unitPrice, 0);
      const ticketsPortion = Math.min(totalDiscount, coveredSubtotal);
      let distrib = 0;
      for (let i = 0; i < coveredQty; i++) {
        const isLast = i === coveredQty - 1;
        const slotIdx = sorted[i];
        const unitPrice = units[slotIdx].rt.unitPrice;
        let allocated = isLast
          ? ticketsPortion - distrib
          : coveredSubtotal > 0
            ? Math.round(ticketsPortion * (unitPrice / coveredSubtotal))
            : 0;
        allocated = Math.min(allocated, unitPrice);
        units[slotIdx].discount = allocated;
        distrib += allocated;
      }
    }
  }

  return units.map(({ rt, discount }) => ({
    ...rt,
    quantity: 1,
    unitDiscount: discount,
    totalDiscount: discount,
    couponApplied: discount > 0,
    finalUnitPrice: rt.unitPrice - discount,
    finalTotalPrice: rt.unitPrice - discount,
  }));
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
