import { OrdersService } from '../orders.service';

/**
 * Contrato do GET /orders/:id/details (order-details-response-spec.md):
 *  - pricing.ticketsSubtotal / productsSubtotal SEPARADOS + couponDiscount/voucherDiscount split.
 *  - registrations[].ticket.unitPrice = preço SÓ do ingresso (sem produtos), centavos.
 *  - Invariante Σ ticket.unitPrice == ticketsSubtotal.
 *  - products[] por registration (não diluído); "Sem interesse" omitido.
 *
 * Cenário do bug: 2 ingressos R$100 + 1 camiseta R$10 comprada SÓ no 1º ingresso.
 */
describe('OrdersService.getOrderDetails — contrato de pricing/ticket.unitPrice', () => {
  const USER = 'user-1';

  const liveTicket = {
    id: 'tk1', name: 'Ingresso Avulso', category: null, distance: 5, distanceUnit: 'km',
    products: [], // sem produtos inclusos
  };
  const regTicket = {
    ticketId: 'tk1', batchId: 'b1', ticket: liveTicket,
    ticketSnapshot: { id: 'tk1', name: 'Ingresso Avulso', category: null, distance: 5, distanceUnit: 'km', batch: { id: 'b1', name: 'Lote 1', price: 10000 } },
  };
  const mkReg = (id: string, products: any[]) => ({
    id, status: 'CONFIRMED', qrCode: `qr-${id}`, createdAt: new Date('2026-06-01'),
    userId: USER, participantCpfClean: null, receiptSnapshot: null,
    user: { id: USER, firstName: 'Maria', lastName: 'Silva', email: 'm@x.com', documentType: 'CPF', documentNumber: '12345678901', documentNumberClean: '12345678901', country: 'Brasil', state: 'SP', city: 'SP', phone: '11999990000', dateOfBirth: new Date('1990-05-01'), gender: 'FEMALE', avatarUrl: null },
    tickets: [regTicket], modalities: [], questionAnswers: [], products,
    emergencyContactName: null, emergencyContactPhone: null,
  });

  const paidProduct = {
    id: 'rp1', productId: 'p_cam', quantity: 1, unitPrice: 1000, totalPrice: 1000,
    variationId: 'v_M', variationEdited: false, productSnapshot: null,
    product: { id: 'p_cam', name: 'Camiseta', image: null, basePrice: 1000, variationType: 'Tamanho', isIncludedInTicket: false, buyerVariationEditAllowed: false, variationEditDeadlineDays: 0, variations: [{ id: 'v_M', name: 'M', price: 1000, stock: 0, sortOrder: 0 }] },
    variation: { id: 'v_M', name: 'M', price: 1000 },
  };
  const optOutProduct = {
    id: 'rp2', productId: 'p_boné', quantity: 1, unitPrice: 0, totalPrice: 0,
    variationId: 'v_sem', variationEdited: false, productSnapshot: null,
    product: { id: 'p_boné', name: 'Boné', image: null, basePrice: 0, variationType: 'Tamanho', isIncludedInTicket: false, buyerVariationEditAllowed: false, variationEditDeadlineDays: 0, variations: [{ id: 'v_sem', name: 'Sem interesse', price: 0, stock: 0, sortOrder: 0 }] },
    variation: { id: 'v_sem', name: 'Sem interesse', price: 0 },
  };

  const order = {
    id: 'order-1', userId: USER, status: 'PAID', createdAt: new Date('2026-06-01'),
    totalAmount: 21000, serviceFee: 0, finalAmount: 21000, discount: 0,
    coupon: null, voucher: null, couponId: null, voucherId: null,
    expiresAt: null, reservedAt: null, cancelledAt: null, cancelledReason: null,
    billingPostalCode: null, billingCountry: null,
    pendingProducts: null,
    reservedTickets: [{ ticketId: 'tk1', batchId: 'b1', quantity: 2, unitPrice: 10000 }],
    event: { id: 'evt_1', name: 'Corrida XYZ', slug: 'corrida-xyz', eventDate: new Date('2026-07-20'), bannerUrl: 'b.png', logoUrl: null, location: 'SP', city: 'São Paulo', state: 'SP', participantFeePercent: 0, organization: { id: 'o1', name: 'Org' } },
    payment: { id: 'pay1', method: 'PIX', status: 'PAID', amount: 21000, transactionId: null, paymentDate: new Date('2026-06-01'), createdAt: new Date('2026-06-01'), metadata: {} },
    registrations: [mkReg('reg_1', [paidProduct, optOutProduct]), mkReg('reg_2', [])],
  };

  const build = () => {
    const client: any = {
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      user: { findUnique: jest.fn().mockResolvedValue({ documentNumberClean: null }) },
      productVariation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prisma: any = { getReadClient: () => client, getWriteClient: () => client };
    return new OrdersService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { record: () => {} } as any);
  };

  it('REGRESSÃO LGPD: snapshot ANTIGO com organization.{email,phone} → contato NÃO sai na resposta', async () => {
    // Snapshots congelados antes de 2026-06-04 carregam o contato do organizador.
    // O read do details deve strip-ar (contato fora do contrato de rota de usuário).
    const legacySnapshot = {
      event: {
        id: 'evt_1', name: 'Corrida XYZ', slug: 'corrida-xyz',
        eventDate: '2026-07-20', bannerUrl: null, logoUrl: null,
        location: { name: 'SP', city: 'São Paulo', state: 'SP' },
        organization: { id: 'o1', name: 'Org', logoUrl: null, email: 'org@vazou.com', phone: '11999990000' },
      },
      billing: null,
      pricing: { ticketsSubtotal: 20000, productsSubtotal: 1000, discount: 0, pixDiscount: 0, finalTotal: 21000, coupon: null, voucher: null },
      products: [],
      participant: {},
      questionAnswers: [],
    };
    const orderWithSnapshot = {
      ...order,
      registrations: [
        { ...mkReg('reg_1', [paidProduct]), receiptSnapshot: legacySnapshot },
        mkReg('reg_2', []),
      ],
    };
    const client: any = {
      order: { findUnique: jest.fn().mockResolvedValue(orderWithSnapshot) },
      user: { findUnique: jest.fn().mockResolvedValue({ documentNumberClean: null }) },
      productVariation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prisma: any = { getReadClient: () => client, getWriteClient: () => client };
    const svc = new OrdersService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { record: () => {} } as any);

    const res = await svc.getOrderDetails(USER, 'order-1');
    // `event` é irmão de `order` dentro de `data` (não filho de `order`).
    const org = res.data.event?.organization;

    expect(org?.name).toBe('Org'); // dados públicos preservados
    expect(org?.email).toBeUndefined(); // contato NUNCA sai
    expect(org?.phone).toBeUndefined();
  });

  it('pricing: ticketsSubtotal/productsSubtotal separados + split de desconto', async () => {
    const res = await build().getOrderDetails(USER, 'order-1');
    const p = res.data.order.pricing;
    expect(p.ticketsSubtotal).toBe(20000); // 2 × 100
    expect(p.productsSubtotal).toBe(1000); // 1 camiseta (10) — "sem interesse" não soma
    expect(p.subtotal).toBe(21000);
    expect(p.couponDiscount).toBe(0);
    expect(p.voucherDiscount).toBe(0);
  });

  it('⭐ cada registration tem ticket.unitPrice = preço SÓ do ingresso (sem diluir produto)', async () => {
    const res = await build().getOrderDetails(USER, 'order-1');
    const regs = res.data.registrations;
    expect(regs[0].ticket.unitPrice).toBe(10000); // NÃO 10500 (diluindo a camiseta)
    expect(regs[1].ticket.unitPrice).toBe(10000);
    expect(regs[0].ticket.distance).toBe(5);
    expect(regs[0].ticket.distanceUnit).toBe('km');
  });

  it('invariante: Σ ticket.unitPrice == ticketsSubtotal', async () => {
    const res = await build().getOrderDetails(USER, 'order-1');
    const soma = res.data.registrations.reduce((s: number, r: any) => s + r.ticket.unitPrice, 0);
    expect(soma).toBe(res.data.order.pricing.ticketsSubtotal);
  });

  it('produto pago fica SÓ na registration que comprou; a outra tem products vazio', async () => {
    const res = await build().getOrderDetails(USER, 'order-1');
    const regs = res.data.registrations;
    expect(regs[0].products).toHaveLength(1); // camiseta (o "sem interesse" foi omitido)
    expect(regs[0].products[0].totalPrice).toBe(1000);
    expect(regs[1].products).toHaveLength(0); // não herda a camiseta
  });

  it('invariante: Σ products.totalPrice == productsSubtotal', async () => {
    const res = await build().getOrderDetails(USER, 'order-1');
    const soma = res.data.registrations.flatMap((r: any) => r.products).reduce((s: number, p: any) => s + p.totalPrice, 0);
    expect(soma).toBe(res.data.order.pricing.productsSubtotal);
  });

  it('variação "Sem interesse" é omitida de products[]', async () => {
    const res = await build().getOrderDetails(USER, 'order-1');
    const nomes = res.data.registrations[0].products.map((p: any) => p.variationName);
    expect(nomes).not.toContain('Sem interesse');
  });

  // ── Pedido GRÁTIS pago (2026-06-25) ─────────────────────────────────────────
  // Bug: na tela de "pagamento aprovado", pedido cobrado R$0 mostrava "Total pago: 204"
  // e a forma de pagamento PIX. Causa: pricing.total caía no RECÁLCULO (totalAmount −
  // discount) em vez de confiar no finalAmount=0 congelado, quando serviceFee=0 (grátis).
  const buildWith = (over: Record<string, any>) => {
    const freeOrder = { ...order, ...over };
    const client: any = {
      order: { findUnique: jest.fn().mockResolvedValue(freeOrder) },
      user: { findUnique: jest.fn().mockResolvedValue({ documentNumberClean: null }) },
      productVariation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prisma: any = { getReadClient: () => client, getWriteClient: () => client };
    return new OrdersService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { record: () => {} } as any);
  };

  it('pedido GRÁTIS pago (finalAmount=0, serviceFee=0) → pricing.total = 0 (confia no congelado, não recalcula)', async () => {
    // finalAmount=0 (cobrado R$0) mas discount NÃO cobre o totalAmount → o recálculo antigo
    // daria 21000. Pós-pagamento deve confiar no finalAmount congelado.
    const svc = buildWith({
      status: 'PAID', serviceFee: 0, finalAmount: 0, discount: 0, totalAmount: 21000,
      payment: { id: 'pay1', method: 'PIX', status: 'PAID', amount: 0, transactionId: null, paymentDate: new Date('2026-06-01'), createdAt: new Date('2026-06-01'), metadata: {} },
    });
    const res = await svc.getOrderDetails(USER, 'order-1');
    expect(res.data.order.pricing.total).toBe(0);
    expect(res.data.order.pricing.serviceFee).toBe(0);
  });

  it('pedido grátis via cupom 100% (discount = totalAmount) → pricing.total = 0', async () => {
    const svc = buildWith({
      status: 'PAID', serviceFee: 0, finalAmount: 0, discount: 21000, totalAmount: 21000,
    });
    const res = await svc.getOrderDetails(USER, 'order-1');
    expect(res.data.order.pricing.total).toBe(0);
  });

  it('pedido pago normal (finalAmount>0) → pricing.total = finalAmount congelado (sem regressão)', async () => {
    const svc = buildWith({ status: 'PAID', serviceFee: 0, finalAmount: 21000, discount: 0, totalAmount: 21000 });
    const res = await svc.getOrderDetails(USER, 'order-1');
    expect(res.data.order.pricing.total).toBe(21000);
  });
});
