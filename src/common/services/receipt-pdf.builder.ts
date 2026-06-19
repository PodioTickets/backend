import { ReceiptPdfData, ReceiptPdfRegistrationRow } from './receipt-pdf.types';

/**
 * Builder PURO e ÚNICO do `ReceiptPdfData` a partir de um pedido (Prisma `Order`
 * com `reservedTickets`, `payment`, `coupon`, `voucher`, `user` (comprador),
 * `event` (+ `organization`) e `registrations` (+ `tickets`/`ticketSnapshot`)).
 *
 * É a fonte de verdade compartilhada entre:
 *  - o download sob demanda (`PaymentsService.generateReceiptPdf`), e
 *  - o anexo do e-mail de confirmação (fluxos de pagamento).
 *
 * Centralizar aqui garante que o COMPROVANTE baixado e o enviado por e-mail são
 * byte-a-byte o mesmo documento. Valores em CENTAVOS de ponta a ponta (unidade
 * que o template do PDF espera).
 *
 * @param order  pedido carregado com os includes acima.
 * @param opts.buyer  comprador resolvido externamente (quando `order.user` não
 *   foi incluído na query — alguns fluxos de e-mail resolvem o buyer à parte).
 */
export function buildReceiptPdfData(
  order: any,
  opts?: { buyer?: { firstName?: string | null; lastName?: string | null; documentNumber?: string | null; country?: string | null } },
): ReceiptPdfData {
  // Preço do ingresso por (ticketId,batchId) → base do preço por inscrição.
  const reservedPriceByKey = new Map<string, number>();
  const reservedPriceByTicket = new Map<string, number>();
  for (const rt of (order.reservedTickets ?? []) as any[]) {
    reservedPriceByKey.set(`${rt.ticketId}:${rt.batchId}`, rt.unitPrice ?? 0);
    if (!reservedPriceByTicket.has(rt.ticketId)) {
      reservedPriceByTicket.set(rt.ticketId, rt.unitPrice ?? 0);
    }
  }

  const rows: ReceiptPdfRegistrationRow[] = (order.registrations ?? []).map(
    (reg: any): ReceiptPdfRegistrationRow => {
      const rt = reg.tickets?.[0];
      const snap = rt?.ticketSnapshot as Record<string, any> | null;
      const price =
        reservedPriceByKey.get(`${rt?.ticketId}:${rt?.batchId}`) ??
        reservedPriceByTicket.get(rt?.ticketId) ??
        snap?.batch?.price ??
        rt?.batch?.price ??
        0;
      const ticketName = snap?.name ?? rt?.ticket?.name ?? '—';
      const ticketCategory =
        snap?.category?.name ?? rt?.ticket?.category?.name ?? undefined;
      const participantName =
        reg.participantName ||
        `${reg.user?.firstName ?? ''} ${reg.user?.lastName ?? ''}`.trim() ||
        'Participante';
      // Produtos adicionais do participante. Lê do productSnapshot (download) OU do
      // product/variation ao vivo (fluxos de e-mail) — o que estiver carregado. Preço
      // por linha = totalPrice (unitPrice × quantidade); 0 para incluso. "Sem interesse"
      // (opt-out de produto opcional) é excluído.
      const products = ((reg.products ?? []) as any[])
        .map((rp: any) => {
          const pSnap = (rp.productSnapshot ?? null) as Record<string, any> | null;
          const variationName =
            pSnap?.selectedVariation?.name ?? rp.variation?.name ?? undefined;
          return {
            name: pSnap?.name ?? rp.product?.name ?? 'Produto',
            variationName,
            price: rp.totalPrice ?? rp.unitPrice ?? 0,
            isIncluded:
              pSnap?.isIncludedInTicket ?? rp.product?.isIncludedInTicket ?? false,
          };
        })
        .filter((p) => p.variationName !== 'Sem interesse');
      return {
        id: reg.id,
        participantName,
        email: reg.participantEmail ?? reg.user?.email ?? undefined,
        ticketCategory,
        ticketName,
        price,
        products,
      };
    },
  );

  const event = order.event ?? {};
  const org = event.organization ?? {};
  const buyer = opts?.buyer ?? order.user ?? {};
  const payment = order.payment ?? {};

  const discount = order.discount ?? 0;
  const hasCoupon = !!order.coupon;
  const hasVoucher = !!order.voucher;
  const serviceFee = computeOrderServiceFee(order);

  return {
    orderNumber: String(order.id).toUpperCase(),
    issuedAt: new Date(),
    organization: {
      name: org.tradeName || org.name || '',
      document: org.document ?? undefined,
      logoUrl: org.logoUrl ?? undefined,
    },
    buyer: {
      name: `${buyer.firstName ?? ''} ${buyer.lastName ?? ''}`.trim() || '—',
      document: buyer.documentNumber ?? undefined,
      country: buyer.country ?? null,
      imageUrl: buyer.avatarUrl ?? undefined,
      birthDate: buyer.dateOfBirth ?? null,
    },
    event: {
      name: event.name ?? '',
      date: event.eventDate ?? new Date(),
      location: formatReceiptEventAddress(event) || '—',
    },
    payment: {
      method: payment.method ?? '',
      paidAt: payment.paymentDate ?? payment.createdAt ?? new Date(),
      status: payment.status ?? undefined,
      refundedAt: extractRefundedAt(payment),
      gateway: payment.gateway ?? undefined,
      transactionId: payment.transactionId ?? undefined,
      cardBrand: payment.cardBrand ?? undefined,
      voucherCode: hasVoucher ? order.voucher?.code : undefined,
      couponCode: hasCoupon ? order.coupon?.code : undefined,
    },
    financial: {
      subtotal: order.totalAmount ?? 0,
      discount,
      // Rótulo da linha de desconto, no mesmo formato do resumo do checkout.
      // Cupom e voucher são exclusivos → no máximo um rótulo.
      discountLabel: buildDiscountLabel(order, discount, hasCoupon, hasVoucher),
      serviceFee,
      total: computeOrderFinalAmount(order, serviceFee),
    },
    registrations: rows,
  };
}

/**
 * Instante do estorno a partir do `payment.metadata` (gravado pelo fluxo de
 * estorno como `refundedAt` ISO). `metadata` pode vir como objeto (Prisma JSON)
 * ou string serializada — tratamos os dois. Retorna `undefined` quando ausente
 * ou inválido (comprovante não-estornado).
 */
function extractRefundedAt(payment: any): Date | undefined {
  let meta = payment?.metadata;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      return undefined;
    }
  }
  const raw = meta?.refundedAt;
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Rótulo da linha de desconto, espelhando o resumo do checkout (`OrderSummary`):
 *  - cupom QUANTITY/AGE → "Cupom automático" (+ "(N% OFF)" se PERCENTAGE);
 *  - cupom DISCOUNT → "Cupom <code>" (+ "(N% OFF)" se PERCENTAGE);
 *  - voucher → "Voucher <code>".
 * Retorna `undefined` quando não há desconto. Cupom e voucher são exclusivos.
 */
function buildDiscountLabel(
  order: any,
  discount: number,
  hasCoupon: boolean,
  hasVoucher: boolean,
): string | undefined {
  if (discount <= 0) return undefined;
  if (hasCoupon) {
    const c = order.coupon ?? {};
    const automatic = c.couponType === 'QUANTITY' || c.couponType === 'AGE';
    const pct =
      c.type === 'PERCENTAGE' && c.value ? ` (${c.value}% OFF)` : '';
    if (automatic) return `Cupom automático${pct}`;
    return `${`Cupom ${c.code ?? ''}`.trim()}${pct}`;
  }
  if (hasVoucher) {
    return order.voucher?.code
      ? `Voucher ${order.voucher.code}`
      : 'Voucher aplicado';
  }
  return 'Desconto';
}

/**
 * Taxa de serviço do pedido (centavos). Pós-pagamento confia no valor congelado
 * (`order.serviceFee`); fallback legado recalcula sobre a base já descontada.
 */
function computeOrderServiceFee(order: any): number {
  if (order?.serviceFee && order.serviceFee > 0) return order.serviceFee;
  const percent = order?.event?.participantFeePercent ?? 0;
  const total = order?.totalAmount ?? 0;
  const discount = order?.discount ?? 0;
  if (!total || !percent) return 0;
  return Math.round(Math.max(0, total - discount) * (percent / 100));
}

/**
 * Valor final do pedido (centavos): `(totalAmount - discount) + serviceFee`.
 * Pós-pagamento usa o `finalAmount` congelado; PENDING recompõe.
 */
function computeOrderFinalAmount(order: any, serviceFee: number): number {
  if (order?.serviceFee && order.serviceFee > 0) return order.finalAmount ?? 0;
  const total = order?.totalAmount ?? 0;
  const discount = order?.discount ?? 0;
  return Math.max(0, total - discount) + serviceFee;
}

/** Endereço do evento p/ o recibo (city - state, bairro, local, CEP). */
function formatReceiptEventAddress(event: any): string {
  const parts: string[] = [];
  const cityState: string[] = [];
  if (event.city) cityState.push(event.city);
  if (event.state) cityState.push(event.state);
  if (cityState.length) parts.push(cityState.join(' - '));
  if (event.neighborhood) parts.push(event.neighborhood);
  if (event.location) parts.push(event.location);
  if (event.zipCode) {
    const cep = String(event.zipCode).replace(/\D/g, '');
    parts.push(cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep);
  }
  return parts.join(', ');
}
