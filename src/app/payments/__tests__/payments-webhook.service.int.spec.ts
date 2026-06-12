/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: processamento do WEBHOOK da Cielo (confirmação de pagamento, ex.: PIX).
 *
 *  EM RESUMO:
 *    Depois que o comprador paga (PIX/débito), a Cielo NÃO espera nossa resposta —
 *    ela manda um "webhook" avisando que "algo mudou" naquele pagamento. O backend
 *    então consulta a Cielo para saber o status REAL e, se virou PAGO:
 *      • Promove o pedido de PENDING → PAID (atômico, à prova de entrega dupla).
 *      • FINALIZA o pedido: apaga as inscrições "placeholder" PENDING que a reserva
 *        tinha criado e cria as inscrições DEFINITIVAS (status CONFIRMED), cada uma
 *        com participante preenchido, ingresso, produtos, snapshot do recibo e qrCode.
 *      • Aplica o uso de cupom (incrementa `usageCount`) e consome o voucher
 *        (ACTIVE → USED), se houver.
 *
 *    IDEMPOTÊNCIA: a Cielo pode entregar o MESMO webhook mais de uma vez. Na segunda
 *    entrega o pedido já não está mais PENDING → o finalize é ignorado e NADA se
 *    repete (não duplica inscrições nem reaplica cupom/voucher).
 *
 *    NÃO APROVADO: se a consulta à Cielo devolver um status que NÃO é "pago"
 *    (ex.: ainda Pending/NotFinished), o pedido continua PENDING e nenhuma
 *    inscrição definitiva é criada.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Webhook PAGO → Order vira PAID + Payment vira PAID + inscrições definitivas
 *      CONFIRMED criadas (com qrCode + participante) + placeholders PENDING removidos
 *      + cupom aplicado (usageCount++) + voucher consumido (USED).
 *    • Entrega DUPLICADA do mesmo webhook → idempotente: continua 1 pedido PAID,
 *      mesmo nº de inscrições, cupom NÃO incrementa de novo, voucher continua USED.
 *    • Webhook de pagamento NÃO aprovado (Cielo devolve status Pending) → Order
 *      segue PENDING, nenhuma inscrição definitiva, placeholders intactos.
 *
 *  COMO CONFERIMOS:
 *    Teste DE VERDADE contra um Postgres de teste (descartável). Montamos no banco um
 *    pedido PENDING completo, PRONTO para finalizar (Order PENDING com
 *    pendingParticipants/pendingProducts + Payment PENDING cujo transactionId bate com
 *    o PaymentId do webhook + OrderReservedTicket + Ticket/TicketBatch/Categoria +
 *    Cupom/Voucher). Chamamos `handleWebhook(...)` e conferimos LENDO o banco de volta.
 *
 *  PREMISSAS / NOTAS PARA QUEM FOR RODAR:
 *    • Cielo, Email, TicketPdf e Gateway (WebSocket) são MOCKADOS — o que validamos
 *      são os EFEITOS NO BANCO, não a integração externa. O `OrderFinalizationService`
 *      é REAL (`new OrderFinalizationService(prisma)`), pois é ele quem cria as
 *      inscrições; só assim o teste exercita o caminho de produção de verdade.
 *    • O webhook NÃO confia no `Status` do payload: ele chama `cielo.getPayment(...)`
 *      e usa o status REAL retornado. Por isso o mock de `getPayment` é a "fonte da
 *      verdade" do cenário — devolvemos `Payment.Status = 2` (PaymentConfirmed) para
 *      "pago" e `Status = 12` (Pending) para "não aprovado". `mapCieloStatusToPaymentStatus`
 *      e `mapCieloStatusToString` são REAIS (delegados a uma instância de CieloService
 *      sem credenciais — esses dois métodos são puros e não tocam rede).
 *    • Shape do payload (interface `CieloWebhookEvent`): { PaymentId, Status,
 *      MerchantOrderId, ReturnCode?, ReturnMessage? }. `PaymentId` precisa bater com
 *      `Payment.transactionId` semeado (é o WHERE do updateMany que vira o pagamento).
 *    • Após a transação, o serviço dispara, FORA dela, o envio de e-mail/PDF
 *      (fire-and-forget, com getReadClient). Esses caminhos estão mockados/no-op e os
 *      erros são engolidos com `.catch` — não afetam os efeitos no banco que medimos.
 *      Damos um pequeno `await tick` para não vazar promessa pendente entre os testes.
 * ============================================================================
 */
import { PaymentMethod, PaymentStatus, OrderStatus, RegistrationStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PaymentsWebhookService } from '../payments-webhook.service';
import { OrderFinalizationService } from '../order-finalization.service';
import { PaymentCompensationService } from '../payment-compensation.service';
import { CieloService } from '../cielo.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  createTestPrisma,
  resetDb,
  seedOrgUserEvent,
  seedUser,
} from '../../../common/testing/integration-db';

// Aguarda a fila de microtasks/macrotasks esvaziar — deixa o fire-and-forget
// pós-transação (email/pdf, todos mockados) resolver antes do próximo teste.
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('PaymentsWebhookService.handleWebhook (integração, banco real)', () => {
  let prisma: PrismaService;
  // Instância só para os 2 mapeadores PUROS (sem rede). getPayment é stubado por teste.
  let cieloMappers: CieloService;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    // CieloService sem credenciais → axios desabilitado, mas mapCieloStatus* são puros.
    cieloMappers = new CieloService(new ConfigService({}));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  // ── Mocks das dependências externas ────────────────────────────────────────

  /** Cria um CieloService MOCK cujo getPayment devolve o status `cieloStatus` (real). */
  const makeCieloMock = (cieloStatus: number) =>
    ({
      getPayment: jest.fn().mockResolvedValue({
        MerchantOrderId: 'mo-test',
        Payment: { PaymentId: 'PAY-XYZ', Status: cieloStatus },
      }),
      // Estorno automático da compensação — sucesso por default nos cenários.
      cancelPayment: jest.fn().mockResolvedValue({ success: true, cieloStatus: 'Voided' }),
      // Delegamos aos mapeadores REAIS (puros) — preserva a semântica de produção.
      mapCieloStatusToPaymentStatus: (s: number) => cieloMappers.mapCieloStatusToPaymentStatus(s),
      mapCieloStatusToString: (s: number) => cieloMappers.mapCieloStatusToString(s),
    }) as any;

  const emailMock = { sendRegistrationConfirmed: jest.fn().mockResolvedValue(undefined) } as any;
  const pdfMock = { generateTicketPdf: jest.fn().mockResolvedValue(Buffer.from('pdf')) } as any;
  const receiptPdfMock = { generateReceiptPdf: jest.fn().mockResolvedValue(Buffer.from('receipt')) } as any;
  const gatewayMock = () => ({ emitPaymentConfirmed: jest.fn() }) as any;

  /** Monta o serviço sob teste com Cielo configurável e finalization REAL. */
  const makeService = (cieloStatus: number) => {
    const gateway = gatewayMock();
    const cielo = makeCieloMock(cieloStatus);
    // Telemetria no-op (o alvo são os efeitos no banco, não o log de atividade).
    const finalization = new OrderFinalizationService(prisma, { record: () => {} } as any); // REAL
    // Compensação REAL (estorno automático) com a MESMA Cielo mockada do cenário —
    // `cancelPayment` resolve sucesso por default; cenários de compensação inspecionam o banco.
    const compensation = new PaymentCompensationService(
      prisma,
      cielo as any,
      { record: () => {} } as any,
    );
    const service = new PaymentsWebhookService(
      prisma,
      cielo,
      emailMock,
      pdfMock,
      receiptPdfMock,
      gateway,
      finalization,
      compensation,
    );
    return { service, gateway, cielo };
  };

  // ── Helpers de montagem (criam linhas REAIS no banco de teste) ──────────────

  /**
   * Semeia um pedido PENDING completo, PRONTO para finalizar:
   *   Categoria → Ticket → Lote (com estoque) → Order PENDING (pendingParticipants +
   *   pendingProducts vazio) → OrderReservedTicket → Payment PENDING (transactionId =
   *   PAYMENT_ID) → placeholder Registration PENDING. Opcionalmente cupom QUANTITY e
   *   voucher (já reservado pelo pedido).
   */
  const PAYMENT_ID = 'PAY-XYZ';

  async function seedPendingOrder(opts: {
    withCoupon?: boolean;
    withVoucher?: boolean;
  } = {}) {
    const w = prisma.getWriteClient();
    const { organizationId, adminUserId, eventId } = await seedOrgUserEvent(prisma);

    const category = await w.ticketCategory.create({
      data: { eventId, name: 'Geral' },
      select: { id: true },
    });
    const ticket = await w.ticket.create({
      data: {
        eventId,
        categoryId: category.id,
        name: 'Ingresso Padrão',
        modality: 'Corrida de rua',
      },
      select: { id: true },
    });
    const batch = await w.ticketBatch.create({
      data: { ticketId: ticket.id, quantity: 100, availableQuantity: 98, price: 5000 },
      select: { id: true, price: true },
    });

    // Cupom QUANTITY opcional (uso all-or-nothing → usageCount++ uma vez no finalize).
    let couponId: string | null = null;
    if (opts.withCoupon) {
      const coupon = await w.coupon.create({
        data: {
          eventId,
          code: 'CUP10',
          couponType: 'QUANTITY',
          type: 'FIXED',
          value: 1000,
          minQuantity: 2,
          usageCount: 0,
          maxUsage: 50,
        },
        select: { id: true },
      });
      couponId = coupon.id;
    }

    // Voucher opcional (ACTIVE, já reservado por ESTE pedido → finalize consome).
    let voucherId: string | null = null;

    // Comprador (dono do pedido) — vamos preenchê-lo como participante.
    const buyer = await w.user.findUnique({
      where: { id: adminUserId },
      select: { email: true, firstName: true, lastName: true },
    });

    // 2 participantes: o comprador + um convidado sem conta (vira guest snapshot).
    const pendingParticipants = [
      {
        name: `${buyer?.firstName ?? 'Fulano'} ${buyer?.lastName ?? ''}`.trim(),
        email: buyer?.email,
        cpf: '39053344705',
        documentType: 'CPF',
        documentNumber: '39053344705',
        phone: '11999990000',
        birthDate: '1990-05-10',
        gender: 'M',
        questionAnswers: [],
      },
      {
        name: 'Convidado Sem Conta',
        email: `convidado-${Date.now()}@teste.com`,
        cpf: '11144477735',
        documentType: 'CPF',
        documentNumber: '11144477735',
        phone: '11988887777',
        birthDate: '1995-03-20',
        gender: 'F',
        questionAnswers: [],
      },
    ];

    const order = await w.order.create({
      data: {
        userId: adminUserId,
        eventId,
        totalAmount: 10000, // 2 × 5000
        serviceFee: 400,
        discount: opts.withCoupon ? 1000 : 0,
        finalAmount: opts.withCoupon ? 9400 : 10400,
        couponId,
        voucherId,
        status: OrderStatus.PENDING,
        billingCountry: 'BR',
        billingPostalCode: '01001000',
        billingStreet: 'Rua Teste',
        billingNumber: '100',
        billingCity: 'São Paulo',
        billingStateUf: 'SP',
        pendingParticipants: pendingParticipants as any,
        pendingProducts: [] as any,
      },
      select: { id: true },
    });

    if (opts.withVoucher) {
      const voucher = await w.voucher.create({
        data: {
          eventId,
          name: 'Lote Cortesia',
          code: `VCH-${Date.now()}`,
          status: 'ACTIVE',
          reservedByOrderId: order.id,
          reservedUntil: new Date(Date.now() + 60 * 60 * 1000),
        },
        select: { id: true },
      });
      voucherId = voucher.id;
      await w.order.update({ where: { id: order.id }, data: { voucherId } });
    }

    // Reserva de ingresso: 1 linha com quantity=2 → finalize cria 2 inscrições.
    await w.orderReservedTicket.create({
      data: {
        orderId: order.id,
        ticketId: ticket.id,
        batchId: batch.id,
        quantity: 2,
        unitPrice: batch.price,
        ticketName: 'Ingresso Padrão',
      },
    });

    // Payment PENDING — transactionId bate com o PaymentId do webhook.
    await w.payment.create({
      data: {
        orderId: order.id,
        userId: adminUserId,
        method: PaymentMethod.PIX,
        status: PaymentStatus.PENDING,
        amount: opts.withCoupon ? 9400 : 10400,
        transactionId: PAYMENT_ID,
        metadata: {},
      },
    });

    // Placeholders PENDING criados pela reserva (devem ser apagados no finalize).
    await w.registration.create({
      data: { eventId, orderId: order.id, userId: adminUserId, status: RegistrationStatus.PENDING },
    });
    await w.registration.create({
      data: { eventId, orderId: order.id, userId: adminUserId, status: RegistrationStatus.PENDING },
    });

    return { organizationId, adminUserId, eventId, orderId: order.id, couponId, voucherId };
  }

  /** Payload "de pago" da Cielo — PaymentId casa com o transactionId semeado. */
  const paidPayload = () => ({
    PaymentId: PAYMENT_ID,
    Status: 2, // PaymentConfirmed (mas o serviço reconfirma via getPayment)
    MerchantOrderId: 'mo-test',
    ReturnCode: '00',
    ReturnMessage: 'Transacao autorizada',
  });

  // ── Cenários ────────────────────────────────────────────────────────────────

  it('webhook de pagamento confirmado → Order PAID + inscrições definitivas + placeholders removidos + cupom/voucher aplicados', async () => {
    const { service, gateway } = makeService(2); // Cielo confirma: Status 2 = PaymentConfirmed
    const { orderId, eventId, couponId, voucherId } = await seedPendingOrder({
      withCoupon: true,
      withVoucher: true,
    });

    await service.handleWebhook(paidPayload());
    await tick();

    const r = prisma.getReadClient();

    // Order promovido a PAID.
    const order = await r.order.findUnique({ where: { id: orderId }, select: { status: true } });
    expect(order?.status).toBe(OrderStatus.PAID);

    // Payment marcado PAID + paymentDate preenchido + metadata do webhook.
    const payment = await r.payment.findFirst({
      where: { transactionId: PAYMENT_ID },
      select: { status: true, paymentDate: true, metadata: true },
    });
    expect(payment?.status).toBe(PaymentStatus.PAID);
    expect(payment?.paymentDate).toBeInstanceOf(Date);
    expect((payment?.metadata as any)?.cieloStatus).toBe('PaymentConfirmed');

    // Nenhum placeholder PENDING sobra.
    const pendingRegs = await r.registration.count({
      where: { orderId, status: RegistrationStatus.PENDING },
    });
    expect(pendingRegs).toBe(0);

    // 2 inscrições definitivas CONFIRMED, cada uma com qrCode e ingresso.
    const regs = await r.registration.findMany({
      where: { orderId },
      include: { tickets: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(regs).toHaveLength(2);
    for (const reg of regs) {
      expect(reg.status).toBe(RegistrationStatus.CONFIRMED);
      expect(reg.qrCode).toBeTruthy();
      expect(reg.tickets).toHaveLength(1);
      expect((reg.receiptSnapshot as any)?.event?.id).toBe(eventId);
    }

    // Comprador entra como participante vinculado (userId preenchido);
    // o convidado sem conta entra como snapshot (participantName preenchido, userId null).
    const guest = regs.find((x) => x.userId === null);
    expect(guest).toBeTruthy();
    expect(guest?.participantName).toBe('Convidado Sem Conta');
    const buyerReg = regs.find((x) => x.userId !== null);
    expect(buyerReg).toBeTruthy();

    // Cupom QUANTITY consumido exatamente 1×.
    const coupon = await r.coupon.findUnique({ where: { id: couponId! }, select: { usageCount: true } });
    expect(coupon?.usageCount).toBe(1);

    // Voucher consumido (ACTIVE → USED), reserva liberada.
    const voucher = await r.voucher.findUnique({
      where: { id: voucherId! },
      select: { status: true, usedBy: true, reservedByOrderId: true },
    });
    expect(voucher?.status).toBe('USED');
    expect(voucher?.reservedByOrderId).toBeNull();

    // WebSocket notificado uma vez.
    expect(gateway.emitPaymentConfirmed).toHaveBeenCalledWith(orderId);
  });

  it('entrega DUPLICADA do mesmo webhook → idempotente: não duplica inscrições nem reaplica cupom/voucher', async () => {
    const { service } = makeService(2);
    const { orderId, couponId, voucherId } = await seedPendingOrder({
      withCoupon: true,
      withVoucher: true,
    });

    // 1ª entrega: finaliza de verdade.
    await service.handleWebhook(paidPayload());
    await tick();

    const r = prisma.getReadClient();
    const after1 = await r.registration.count({ where: { orderId, status: RegistrationStatus.CONFIRMED } });
    expect(after1).toBe(2);

    // 2ª entrega do MESMO webhook (Order já PAID → finalize ignorado).
    await service.handleWebhook(paidPayload());
    await tick();

    // Continua exatamente 2 inscrições confirmadas (não duplicou).
    const after2 = await r.registration.count({ where: { orderId, status: RegistrationStatus.CONFIRMED } });
    expect(after2).toBe(2);

    // Order continua único e PAID.
    const order = await r.order.findUnique({ where: { id: orderId }, select: { status: true } });
    expect(order?.status).toBe(OrderStatus.PAID);

    // Cupom NÃO foi incrementado de novo.
    const coupon = await r.coupon.findUnique({ where: { id: couponId! }, select: { usageCount: true } });
    expect(coupon?.usageCount).toBe(1);

    // Voucher continua USED (não foi "re-consumido").
    const voucher = await r.voucher.findUnique({ where: { id: voucherId! }, select: { status: true } });
    expect(voucher?.status).toBe('USED');
  });

  it('webhook de pagamento NÃO aprovado (Cielo retorna Pending) → Order segue PENDING, sem inscrições definitivas', async () => {
    // Cielo devolve Status 12 (Pending) → mapeia para PaymentStatus.PENDING.
    const { service, gateway } = makeService(12);
    const { orderId, couponId } = await seedPendingOrder({ withCoupon: true });

    await service.handleWebhook(paidPayload());
    await tick();

    const r = prisma.getReadClient();

    // Order continua PENDING.
    const order = await r.order.findUnique({ where: { id: orderId }, select: { status: true } });
    expect(order?.status).toBe(OrderStatus.PENDING);

    // Payment NÃO virou PAID (transição para PENDING não dispara finalize).
    const payment = await r.payment.findFirst({
      where: { transactionId: PAYMENT_ID },
      select: { status: true },
    });
    expect(payment?.status).toBe(PaymentStatus.PENDING);

    // Nenhuma inscrição CONFIRMED; os 2 placeholders PENDING continuam intactos.
    const confirmed = await r.registration.count({ where: { orderId, status: RegistrationStatus.CONFIRMED } });
    expect(confirmed).toBe(0);
    const pending = await r.registration.count({ where: { orderId, status: RegistrationStatus.PENDING } });
    expect(pending).toBe(2);

    // Cupom não foi tocado.
    const coupon = await r.coupon.findUnique({ where: { id: couponId! }, select: { usageCount: true } });
    expect(coupon?.usageCount).toBe(0);

    // Sem confirmação → WebSocket não é notificado.
    expect(gateway.emitPaymentConfirmed).not.toHaveBeenCalled();
  });

  // ── ANTI-REGRESSÃO de status (2026-06-05) ───────────────────────────────────
  // Antes: o webhook reconsulta a Cielo e aplicava o status real SEM guard de
  // direção — um crédito já finalizado como PAID era REBAIXADO pra PENDING quando
  // a Cielo notificava Status 1 (Authorized, ainda não liquidado) ou 12 (Pending).

  it('ANTI-REGRESSÃO: webhook com status intermediário (Authorized=1) NÃO rebaixa Payment já PAID', async () => {
    // 1º webhook: Cielo confirma (Status 2) → finaliza tudo (Order PAID, Payment PAID).
    const confirmed = makeService(2);
    const { orderId } = await seedPendingOrder();
    await confirmed.service.handleWebhook(paidPayload());
    await tick();

    const r = prisma.getReadClient();
    const paidBefore = await r.payment.findFirst({
      where: { transactionId: PAYMENT_ID },
      select: { status: true },
    });
    expect(paidBefore?.status).toBe(PaymentStatus.PAID);

    // 2º webhook (replay/notificação atrasada): status REAL na Cielo é 1 (Authorized).
    const intermediate = makeService(1);
    await expect(intermediate.service.handleWebhook(paidPayload())).resolves.not.toThrow();
    await tick();

    // Payment continua PAID — o status intermediário foi ignorado.
    const paidAfter = await r.payment.findFirst({
      where: { transactionId: PAYMENT_ID },
      select: { status: true },
    });
    expect(paidAfter?.status).toBe(PaymentStatus.PAID);

    // Order e inscrições intactos.
    const order = await r.order.findUnique({ where: { id: orderId }, select: { status: true } });
    expect(order?.status).toBe(OrderStatus.PAID);
    const confirmedRegs = await r.registration.count({
      where: { orderId, status: RegistrationStatus.CONFIRMED },
    });
    expect(confirmedRegs).toBe(2);

    // Nenhuma nova notificação de confirmação disparada pelo replay.
    expect(intermediate.gateway.emitPaymentConfirmed).not.toHaveBeenCalled();
  });

  it('ANTI-REGRESSÃO: webhook PAID atrasado NÃO sobrescreve Payment já REFUNDED (compensação/estorno)', async () => {
    const { orderId } = await seedPendingOrder();

    // Pagamento já estornado (ex.: compensação automática concluiu antes do replay).
    const w = prisma.getWriteClient();
    await w.payment.updateMany({
      where: { transactionId: PAYMENT_ID },
      data: { status: PaymentStatus.REFUNDED },
    });
    await w.order.update({ where: { id: orderId }, data: { status: OrderStatus.CANCELLED } });

    // Webhook atrasado: Cielo (real) diz Status 2 = PaymentConfirmed.
    const { service, gateway } = makeService(2);
    await expect(service.handleWebhook(paidPayload())).resolves.not.toThrow();
    await tick();

    // REFUNDED é terminal — não volta a PAID por replay.
    const r = prisma.getReadClient();
    const payment = await r.payment.findFirst({
      where: { transactionId: PAYMENT_ID },
      select: { status: true },
    });
    expect(payment?.status).toBe(PaymentStatus.REFUNDED);

    // Pedido cancelado segue cancelado; nada foi finalizado/notificado.
    const order = await r.order.findUnique({ where: { id: orderId }, select: { status: true } });
    expect(order?.status).toBe(OrderStatus.CANCELLED);
    expect(gateway.emitPaymentConfirmed).not.toHaveBeenCalled();
  });

  // ── COMPENSAÇÃO AUTOMÁTICA (regressões 2026-06-04) ─────────────────────────
  // Antes: (1) voucher consumido por outro pedido → finalize lançava 500 pro webhook →
  // Cielo reentregava pra sempre, cliente pago sem ingresso e sem estorno; (2) webhook
  // confirmando pedido JÁ CANCELADO pelo cron → Payment ficava PAID órfão eternamente.

  it('COMPENSAÇÃO: voucher consumido por OUTRO pedido → estorno automático + pedido cancelado (sem 500/loop)', async () => {
    const { service, gateway, cielo } = makeService(2);
    const { orderId, voucherId } = await seedPendingOrder({ withVoucher: true });

    // Outro usuário "rouba" e consome o voucher entre o QR e a confirmação (reserva vencida).
    const otherUserId = await seedUser(prisma, 'USER');
    await prisma.getWriteClient().voucher.update({
      where: { id: voucherId! },
      data: { status: 'USED', usedAt: new Date(), usedBy: otherUserId, reservedByOrderId: null, reservedUntil: null },
    });

    // O webhook NÃO pode lançar (lançar = 500 = reentrega infinita da Cielo).
    await expect(service.handleWebhook(paidPayload())).resolves.not.toThrow();
    await tick();

    const r = prisma.getReadClient();

    // Estorno automático disparado na Cielo.
    expect(cielo.cancelPayment).toHaveBeenCalledWith(PAYMENT_ID);

    // Payment → REFUNDED com a classificação de compensação.
    const payment = await r.payment.findFirst({
      where: { transactionId: PAYMENT_ID },
      select: { status: true, metadata: true },
    });
    expect(payment?.status).toBe(PaymentStatus.REFUNDED);
    expect((payment?.metadata as any)?.refundType).toBe('AUTO_COMPENSATION');
    expect((payment?.metadata as any)?.compensationReason).toBe('VOUCHER_CONSUMED');

    // Pedido cancelado com devolução de estoque (98 → 100) e placeholders cancelados.
    const order = await r.order.findUnique({
      where: { id: orderId },
      select: { status: true, cancelledReason: true, reservedTickets: { select: { batchId: true } } },
    });
    expect(order?.status).toBe(OrderStatus.CANCELLED);
    expect(order?.cancelledReason).toContain('VOUCHER_CONSUMED');
    const batch = await r.ticketBatch.findUnique({
      where: { id: order!.reservedTickets[0].batchId },
      select: { availableQuantity: true },
    });
    expect(batch?.availableQuantity).toBe(100);

    // Nada entregue: zero inscrições CONFIRMED.
    const confirmed = await r.registration.count({ where: { orderId, status: RegistrationStatus.CONFIRMED } });
    expect(confirmed).toBe(0);

    // O voucher do outro usuário fica intacto (não foi "roubado de volta").
    const voucher = await r.voucher.findUnique({ where: { id: voucherId! }, select: { status: true, usedBy: true } });
    expect(voucher?.status).toBe('USED');
    expect(voucher?.usedBy).toBe(otherUserId);

    // Sem confirmação → front não recebe paymentConfirmed.
    expect(gateway.emitPaymentConfirmed).not.toHaveBeenCalled();
  });

  it('COMPENSAÇÃO: webhook confirma pedido JÁ CANCELADO pelo cron → Payment estornado (não fica PAID órfão)', async () => {
    const { service, gateway, cielo } = makeService(2);
    const { orderId } = await seedPendingOrder();

    // Simula o cron de expiração: pedido cancelado + estoque já devolvido (98 → 100).
    const w = prisma.getWriteClient();
    await w.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED, cancelledAt: new Date(), cancelledReason: 'EXPIRED' },
    });
    const rt = await w.orderReservedTicket.findFirst({ where: { orderId }, select: { batchId: true } });
    await w.ticketBatch.update({ where: { id: rt!.batchId }, data: { availableQuantity: 100 } });

    await expect(service.handleWebhook(paidPayload())).resolves.not.toThrow();
    await tick();

    const r = prisma.getReadClient();

    // Estorno automático na Cielo + Payment REFUNDED (antes: ficava PAID pra sempre).
    expect(cielo.cancelPayment).toHaveBeenCalledWith(PAYMENT_ID);
    const payment = await r.payment.findFirst({
      where: { transactionId: PAYMENT_ID },
      select: { status: true, metadata: true },
    });
    expect(payment?.status).toBe(PaymentStatus.REFUNDED);
    expect((payment?.metadata as any)?.compensationReason).toBe('PAID_AFTER_CANCELLATION');

    // Pedido permanece CANCELLED e o estoque NÃO é devolvido em dobro (continua 100).
    const order = await r.order.findUnique({ where: { id: orderId }, select: { status: true } });
    expect(order?.status).toBe(OrderStatus.CANCELLED);
    const batch = await r.ticketBatch.findUnique({ where: { id: rt!.batchId }, select: { availableQuantity: true } });
    expect(batch?.availableQuantity).toBe(100);

    // Nada entregue, nada confirmado pro front.
    const confirmed = await r.registration.count({ where: { orderId, status: RegistrationStatus.CONFIRMED } });
    expect(confirmed).toBe(0);
    expect(gateway.emitPaymentConfirmed).not.toHaveBeenCalled();
  });
});
