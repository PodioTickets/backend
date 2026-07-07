import {
  distributeDiscount,
  inferEffectiveUsage,
} from '../orders/order-discount.util';

/**
 * Calcula, POR INSCRIÇÃO, o "valor realmente pago pelo ingresso" exibido no export
 * de inscrições: ingresso(s) + produtos adicionais − desconto (cupom/voucher)
 * rateado, SEM a taxa de serviço.
 *
 * Reproduz o RECIBO: usa a MESMA distribuição por unidade que o `orderShape` aplica
 * em pedidos PAGOS (`inferEffectiveUsage` + `distributeDiscount` sobre
 * `order.reservedTickets`). Assim o valor por ingresso bate com o comprovante — não
 * é uma alocação inventada.
 *
 * O desconto que NÃO coube nos ingressos (cupom/voucher com applyToProducts) é a
 * porção de produtos; é rateada proporcionalmente ao valor dos produtos de cada
 * inscrição. Isso mantém o total do pedido exato; o escopo por-participante de
 * cupom applyToProducts multi-participante é aproximado (raro).
 *
 * Puro/testável: recebe as inscrições no shape carregado pelo export e devolve
 * `Map<registrationId, centavos>`.
 */

interface RawReservedTicket {
  ticketId: string;
  unitPrice: number;
  quantity: number;
}

/** Preço unitário (centavos) do ingresso da inscrição — batch vivo → snapshot → 0. */
function regTicketUnitPrice(rt: any): number {
  return (
    rt?.batch?.price ??
    rt?.ticketSnapshot?.batch?.price ??
    0
  );
}

/** Subtotal (centavos) dos produtos adicionais da inscrição (opt-out "Sem interesse" = 0). */
function regProductsGross(reg: any): number {
  return (reg?.products ?? []).reduce(
    (s: number, rp: any) => s + (rp?.totalPrice ?? 0),
    0,
  );
}

export function computeRegistrationPaidValues(
  registrations: any[],
): Map<string, number> {
  const result = new Map<string, number>();

  // Agrupa por pedido — a distribuição do desconto é feita sobre o pedido inteiro
  // (todas as unidades de reservedTickets), independente de quais inscrições
  // passaram no filtro do export.
  const byOrder = new Map<string, any[]>();
  for (const reg of registrations) {
    const orderId = reg?.order?.id ?? reg?.orderId;
    if (!orderId) {
      // Sem pedido: cai no bruto (ingresso + produtos), sem desconto.
      result.set(reg.id, computeGrossOnly(reg));
      continue;
    }
    const list = byOrder.get(orderId) ?? [];
    list.push(reg);
    byOrder.set(orderId, list);
  }

  for (const regs of byOrder.values()) {
    const order = regs[0].order ?? {};
    const reserved: RawReservedTicket[] = (order.reservedTickets ?? []).map(
      (x: any) => ({
        ticketId: x.ticketId,
        unitPrice: x.unitPrice ?? 0,
        quantity: x.quantity ?? 1,
      }),
    );
    const discount = order.discount ?? 0;
    const coupon = order.coupon
      ? {
          type: order.coupon.type,
          value: order.coupon.value,
          appliesTo: order.coupon.appliesTo ?? null,
        }
      : null;

    // Sem pedido com lotes reservados (dado legado/inconsistente): bruto por inscrição.
    if (reserved.length === 0) {
      for (const reg of regs) result.set(reg.id, computeGrossOnly(reg));
      continue;
    }

    const fixedPerUnit =
      coupon?.type === 'FIXED' ? coupon.value : undefined;
    const effectiveUsage = inferEffectiveUsage(reserved, coupon, discount);
    const units = distributeDiscount(reserved, discount, effectiveUsage, fixedPerUnit);

    // Fila de valores líquidos por ticketId (net = finalTotalPrice do recibo).
    const netByTicket = new Map<string, number[]>();
    let ticketDiscountTotal = 0;
    for (const u of units) {
      ticketDiscountTotal += u.unitDiscount ?? 0;
      const arr = netByTicket.get(u.ticketId) ?? [];
      arr.push(u.finalTotalPrice ?? u.unitPrice ?? 0);
      netByTicket.set(u.ticketId, arr);
    }

    const ticketsSubtotal = reserved.reduce(
      (s, x) => s + x.unitPrice * x.quantity,
      0,
    );
    const productsSubtotalOrder = Math.max(
      0,
      (order.totalAmount ?? 0) - ticketsSubtotal,
    );
    // Porção do desconto que recaiu sobre PRODUTOS (applyToProducts).
    const productDiscountTotal = Math.max(0, discount - ticketDiscountTotal);

    for (const reg of regs) {
      let ticketNet = 0;
      for (const t of reg.tickets ?? []) {
        const queue = netByTicket.get(t?.ticketId);
        if (queue && queue.length > 0) {
          ticketNet += queue.shift() as number;
        } else {
          // Ingresso da inscrição sem unidade correspondente no pedido (drift):
          // usa o preço bruto do próprio snapshot, sem desconto.
          ticketNet += regTicketUnitPrice(t);
        }
      }

      const productsGross = regProductsGross(reg);
      const productDiscount =
        productsSubtotalOrder > 0
          ? Math.min(
              productsGross,
              Math.round(
                (productDiscountTotal * productsGross) / productsSubtotalOrder,
              ),
            )
          : 0;

      result.set(reg.id, Math.max(0, ticketNet + productsGross - productDiscount));
    }
  }

  return result;
}

/** Valor bruto (ingresso + produtos), sem desconto — fallback p/ pedido ausente. */
function computeGrossOnly(reg: any): number {
  const ticketGross = (reg?.tickets ?? []).reduce(
    (s: number, t: any) => s + regTicketUnitPrice(t),
    0,
  );
  return Math.max(0, ticketGross + regProductsGross(reg));
}
