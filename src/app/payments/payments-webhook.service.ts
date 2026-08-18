import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CieloService } from './cielo.service';
import { MercadoPagoService } from './mercadopago.service';
import { PaymentsService } from './payments.service';
import { EmailService } from '../../common/services/email.service';
import { TicketPdfService } from '../../common/services/ticket-pdf.service';
import { ReceiptPdfService } from '../../common/services/receipt-pdf.service';
import { buildReceiptPdfData } from '../../common/services/receipt-pdf.builder';
import { formatPdfAnswer } from '../../common/utils/pdf-answer.util';
import { PaymentGateway } from './payment.gateway';
import { OrderFinalizationService, OrderFinalizationAbortError } from './order-finalization.service';
import { PaymentCompensationService } from './payment-compensation.service';
import { PaymentMethod, PaymentStatus } from '@prisma/client';
import { formatEventHappensDate, formatEventCardAddress } from '../../common/utils/event-email-format.util';

interface CieloWebhookEvent {
  PaymentId: string;
  Status: number;
  ReturnCode?: string;
  ReturnMessage?: string;
  MerchantOrderId: string;
}

@Injectable()
export class PaymentsWebhookService {
  private readonly logger = new Logger(PaymentsWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cieloService: CieloService,
    private readonly mercadoPagoService: MercadoPagoService,
    private readonly paymentsService: PaymentsService,
    private readonly emailService: EmailService,
    private readonly ticketPdfService: TicketPdfService,
    private readonly receiptPdfService: ReceiptPdfService,
    private readonly gateway: PaymentGateway,
    private readonly orderFinalization: OrderFinalizationService,
    private readonly compensation: PaymentCompensationService,
  ) {}

  /**
   * Webhook do Mercado Pago (topic payment) — DÉBITO apenas.
   *
   * Mesma defesa em profundidade do webhook Cielo: o payload só diz "algo mudou
   * no pagamento X" — o status REAL é consultado na API do MP antes de qualquer
   * transição (a assinatura x-signature já foi validada no controller).
   *
   * Semântica idêntica ao handleWebhook Cielo:
   *  • intermediários (pending/in_process) → ignorados;
   *  • refunded/charged_back → delegado ao cron diário de chargeback (Payment
   *    fica PAID para continuar no filtro do cron);
   *  • rejected/cancelled → FAILED; approved → PAID + finalize compartilhado.
   */
  async handleMpWebhook(mpPaymentId: string) {
    this.logger.log(`Processing MP webhook: payment ${mpPaymentId}`);

    const mpPayment = await this.mercadoPagoService.getPayment(mpPaymentId);
    if (!mpPayment.mpPaymentId) {
      this.logger.warn(`MP webhook: getPayment(${mpPaymentId}) falhou — payload pode ser forjado, abortando.`);
      return;
    }
    const paymentStatus = this.mercadoPagoService.mapMpStatusToPaymentStatus(mpPayment.mpStatus);
    if (!paymentStatus) {
      this.logger.warn(`MP webhook: status desconhecido '${mpPayment.mpStatus}' para ${mpPaymentId} — ignorado`);
      return;
    }

    if (paymentStatus === PaymentStatus.PENDING) {
      this.logger.log(`MP webhook ignorado (status intermediário ${mpPayment.mpStatus}) para ${mpPaymentId}`);
      return;
    }

    // Reversão: mesmo contrato da Cielo — quem processa é o cron de chargeback
    // (varre Payments PAID); rebaixar aqui tiraria o payment do filtro do cron.
    if (paymentStatus === PaymentStatus.REFUNDED) {
      this.logger.log(`MP webhook reversão (${mpPayment.mpStatus}) para ${mpPaymentId} — deixado para o cron de chargeback.`);
      return;
    }

    let confirmedOrderId: string | null = null;
    let orphanCancelledOrderId: string | null = null;

    try {
      await this.prisma.$transaction(async (prisma) => {
        const updated = await prisma.payment.updateMany({
          where: {
            transactionId: mpPaymentId,
            status: {
              notIn:
                paymentStatus === PaymentStatus.PAID
                  ? [paymentStatus, PaymentStatus.REFUNDED]
                  : [paymentStatus],
            },
          },
          data: {
            status: paymentStatus,
            paymentDate: paymentStatus === PaymentStatus.PAID ? new Date() : undefined,
          },
        });

        if (updated.count === 0) {
          this.logger.log(`MP webhook idempotent: payment ${mpPaymentId} already at status ${paymentStatus}`);
          return;
        }

        const fresh = await prisma.payment.findFirst({ where: { transactionId: mpPaymentId } });
        if (!fresh) return;

        await prisma.payment.update({
          where: { id: fresh.id },
          data: {
            metadata: {
              ...(fresh.metadata as object),
              mpStatus: mpPayment.mpStatus,
              mpStatusDetail: mpPayment.statusDetail,
              webhookProcessedAt: new Date().toISOString(),
            } as any,
          },
        });

        if (paymentStatus === PaymentStatus.PAID) {
          const { finalized, orderStatus } = await this.orderFinalization.confirmAndFinalizeOrder(prisma, fresh.orderId);
          if (!finalized) {
            this.logger.warn(`MP webhook: Order ${fresh.orderId} não estava PENDING ao confirmar PAID — efeitos ignorados`);
            if (orderStatus === 'CANCELLED') orphanCancelledOrderId = fresh.orderId;
            return;
          }
          confirmedOrderId = fresh.orderId;
        }

        this.logger.log(`Payment ${fresh.id} updated via MP webhook to status ${paymentStatus}`);
      }, { timeout: 30000, maxWait: 10000 });
    } catch (err: unknown) {
      if (err instanceof OrderFinalizationAbortError) {
        this.logger.error(`MP webhook: finalize abortado (${err.code}) para order ${err.orderId} — compensando com estorno automático`);
        await this.compensation.compensateOrphanPayment(err.orderId, err.code);
        return;
      }
      throw err;
    }

    if (orphanCancelledOrderId) {
      await this.compensation.compensateOrphanPayment(orphanCancelledOrderId, 'PAID_AFTER_CANCELLATION');
      return;
    }

    if (confirmedOrderId) {
      this.gateway.emitPaymentConfirmed(confirmedOrderId);
      // E-mail de confirmação + PDFs — mesmo helper do polling PIX (fire-and-forget).
      this.paymentsService
        .sendConfirmationEmailForOrder(confirmedOrderId)
        .catch((err: any) => this.logger.warn(`MP webhook: falha ao enviar email de confirmação: ${err?.message}`));
    }
  }

  async handleWebhook(event: CieloWebhookEvent) {
    this.logger.log(`Processing Cielo webhook: PaymentId ${event.PaymentId}, Status ${event.Status}`);

    /* Defesa em profundidade: NÃO confia cegamente no status do payload.
     * O webhook só notifica que "algo mudou" naquele PaymentId — busca o status
     * real na API da Cielo antes de aplicar qualquer transição. Sem esta query,
     * um atacante que conseguisse forjar o webhook (signature bypass, replay
     * antigo, etc.) poderia marcar pedidos como PAID. Mesmo padrão usado em
     * handle3dsCallback (linha 429-439).
     *
     * Performance: query feita só em webhooks legítimos (após signature check).
     * O 3DS callback faz a mesma chamada e nunca foi gargalo.
     */
    let paymentStatus: PaymentStatus;
    // Status REAL consultado na Cielo (não o do payload) — usado nas transições
    // e na delegação de reversão abaixo.
    let actualCieloStatus: number;
    // Identificadores da liquidação (mesma resposta da Cielo já consultada acima —
    // sem request extra). Cartão devolve ProofOfSale (NSU); PIX Cielo2 devolve
    // EndToEndId (E2E), que só existe DEPOIS do pagamento e chega justamente aqui.
    // Persistidos no metadata para o modal de pedido exibir o NSU também no PIX.
    let cieloProofOfSale: string | undefined;
    let cieloEndToEndId: string | undefined;
    try {
      const cieloPayment = await this.cieloService.getPayment(event.PaymentId);
      if (!cieloPayment) {
        this.logger.warn(`Webhook: getPayment(${event.PaymentId}) retornou null — payload pode ser forjado, abortando.`);
        return;
      }
      actualCieloStatus = cieloPayment.Payment.Status;
      cieloProofOfSale = cieloPayment.Payment.ProofOfSale;
      cieloEndToEndId = cieloPayment.Payment.EndToEndId;
      paymentStatus = this.cieloService.mapCieloStatusToPaymentStatus(actualCieloStatus);
      if (actualCieloStatus !== event.Status) {
        this.logger.warn(`Webhook status divergente da Cielo: payload=${event.Status}, Cielo=${actualCieloStatus}. Usando valor real (${actualCieloStatus}).`);
      }
    } catch (err: any) {
      this.logger.error(`Webhook: erro ao validar status na Cielo: ${err?.message ?? 'unknown'}`);
      return;
    }

    /* Anti-regressão: status intermediários da Cielo (0=NotFinished, 1=Authorized,
     * 12=Pending) mapeiam pra PENDING e NUNCA rebaixam um Payment já decidido —
     * ex.: crédito finalizado como PAID sendo notificado enquanto a captura
     * liquida voltava a PENDING. Transições válidas chegam só via status finais
     * (2=PAID, 3/13=FAILED, 10/11=REFUNDED); um Payment que ainda está PENDING
     * não precisa de update (já nasce PENDING no pay). */
    if (paymentStatus === PaymentStatus.PENDING) {
      this.logger.log(
        `Webhook ignorado (status intermediário ${event.Status}) para payment ${event.PaymentId}`,
      );
      return;
    }

    /* Reversão (10=Voided / 11=Refunded): o webhook NÃO trata — quem processa é
     * o cron diário de chargeback (PaymentsChargebackService, 03:00), que faz a
     * reversão completa e idempotente. CRÍTICO: o webhook precisa deixar o
     * Payment INTACTO (PAID) — se rebaixasse pra REFUNDED aqui, o payment saía
     * do filtro do cron (que varre só status PAID) e a reversão nunca rodava:
     * comprador estornado ficava com ingressos válidos pra sempre. */
    if (paymentStatus === PaymentStatus.REFUNDED) {
      this.logger.log(
        `Webhook reversão (status ${actualCieloStatus}) para ${event.PaymentId} — deixado para o cron diário de chargeback.`,
      );
      return;
    }

    // orderId capturado durante a transação para uso posterior (fora da transação)
    let confirmedOrderId: string | null = null;
    // Pagamento confirmado TARDE DEMAIS: Order já CANCELLED (cron de expiração). O Payment
    // ficou PAID mas não há entrega possível → compensação (estorno automático) FORA da tx.
    let orphanCancelledOrderId: string | null = null;

    // Atualização atômica dentro de uma única transação.
    // updateMany com condição "status diferente do novo" garante que:
    //   • count=1 → este worker processou; prossegue com efeitos colaterais.
    //   • count=0 → outro worker já aplicou este status; ignora (idempotência).
    // Elimina a race condition entre webhooks duplicados ou entrega dupla.
    try {
      await this.prisma.$transaction(async (prisma) => {
        const updated = await prisma.payment.updateMany({
          where: {
            transactionId: event.PaymentId,
            // Idempotência (não reaplica o mesmo status) + anti-regressão: um
            // Payment já REFUNDED (compensação/estorno) nunca volta a PAID por
            // webhook atrasado ou replay.
            status: {
              notIn:
                paymentStatus === PaymentStatus.PAID
                  ? [paymentStatus, PaymentStatus.REFUNDED]
                  : [paymentStatus],
            },
          },
          data: {
            status: paymentStatus,
            paymentDate: paymentStatus === PaymentStatus.PAID ? new Date() : undefined,
          },
        });

        if (updated.count === 0) {
          this.logger.log(`Webhook idempotent: payment ${event.PaymentId} already at status ${paymentStatus}`);
          return;
        }

        // Recarregar para obter metadata e orderId atualizados
        const fresh = await prisma.payment.findFirst({
          where: { transactionId: event.PaymentId },
        });
        if (!fresh) return;

        await prisma.payment.update({
          where: { id: fresh.id },
          data: {
            metadata: {
              ...(fresh.metadata as object),
              // Status REAL consultado na Cielo — não o do payload (que pode ser
              // replay atrasado/forjado e divergir da transição aplicada).
              cieloStatus: this.cieloService.mapCieloStatusToString(actualCieloStatus),
              webhookProcessedAt: new Date().toISOString(),
              returnCode: event.ReturnCode,
              returnMessage: event.ReturnMessage,
              // NSU/E2E da liquidação. Só sobrescreve quando a Cielo devolveu o
              // valor (evita apagar um proofOfSale já gravado no pay do cartão).
              ...(cieloProofOfSale ? { proofOfSale: cieloProofOfSale } : {}),
              ...(cieloEndToEndId ? { endToEndId: cieloEndToEndId } : {}),
            } as any,
          },
        });

        if (paymentStatus === PaymentStatus.PAID) {
          // Fonte ÚNICA: promove Order PENDING→PAID (atômico/idempotente) + finalize
          // compartilhado (deleta placeholders + cria inscrições completas + aplica
          // cupom/voucher). Se já não estava PENDING (entrega dupla), finalized=false.
          const { finalized, orderStatus } = await this.orderFinalization.confirmAndFinalizeOrder(prisma, fresh.orderId);
          if (!finalized) {
            this.logger.warn(`Webhook: Order ${fresh.orderId} não estava PENDING ao confirmar PAID — efeitos ignorados`);
            // Já PAID = entrega dupla benigna. CANCELLED = pago tarde demais → compensa.
            if (orderStatus === 'CANCELLED') orphanCancelledOrderId = fresh.orderId;
            return;
          }
          // Captura orderId para envio de email fora da transação
          confirmedOrderId = fresh.orderId;
        }

        this.logger.log(`Payment ${fresh.id} updated via webhook to status ${paymentStatus}`);
      }, { timeout: 30000, maxWait: 10000 });
    } catch (err: unknown) {
      // Finalize abortado pós-captura (voucher consumido por outro pedido / participantes
      // vazios): a tx deu rollback (nada meio-entregue) e o pagamento capturado é compensado
      // com estorno automático. Retornamos NORMALMENTE (200) — antes o erro propagava 500 e
      // a Cielo reentregava o webhook para sempre, sem nunca estornar.
      if (err instanceof OrderFinalizationAbortError) {
        this.logger.error(`Webhook: finalize abortado (${err.code}) para order ${err.orderId} — compensando com estorno automático`);
        await this.compensation.compensateOrphanPayment(err.orderId, err.code);
        return;
      }
      throw err;
    }

    if (orphanCancelledOrderId) {
      await this.compensation.compensateOrphanPayment(orphanCancelledOrderId, 'PAID_AFTER_CANCELLATION');
      return;
    }

    // Notify connected frontend clients immediately
    if (confirmedOrderId) {
      this.gateway.emitPaymentConfirmed(confirmedOrderId);
    }

    // Fire-and-forget fora da transação: usa read client (transaction client já foi commitado)
    if (confirmedOrderId) {
      const orderId = confirmedOrderId;
      this.prisma.getReadClient().order.findUnique({
        where: { id: orderId },
        include: {
          // Comprador + reservedTickets: insumos do comprovante (recibo) do pedido.
          user: true,
          reservedTickets: true,
          event: {
            include: { organization: true },
          },
          payment: true,
          coupon: true,
          voucher: true,
          registrations: {
            include: {
              user: true,
              tickets: { include: { ticket: { include: { category: true } } } },
              products: { include: { product: true, variation: true } },
              questionAnswers: { include: { question: true } },
            },
          },
        },
      }).then(async (order: any) => {
        if (!order) return;
        const event = order.event;
        const org = event?.organization ?? {};
        const orgName = org.tradeName || org.name || '';
        const regs: any[] = order.registrations ?? [];
        if (!regs.length) return;

        const issuedAt = new Date();
        const orderNumber = orderId.slice(0, 8).toUpperCase();

        // Comprador = DONO do pedido (order.userId), nunca a primeira inscricao
        // com conta (pode ser o terceiro quando compra pra outra pessoa).
        const buyerUserIdForPdf = order.userId as string | undefined;

        // Build TicketPdfData
        const ticketPdfData = {
          orderId,
          orderNumber,
          issuedAt,
          event: {
            name: event?.name ?? '',
            date: event?.eventDate ?? new Date(),
            organization: orgName,
            location: formatEventCardAddress(event),
            participantCount: regs.length,
          },
          registrations: regs.map((reg: any, idx: number) => {
            // Sempre usa reg.user como fallback — convidado COM conta tem
            // participantX null mas dados em reg.user; zerar escondia a secao.
            const user = reg.user ?? {};
            const ticket = reg.tickets?.[0]?.ticket;
            const catName = ticket?.category?.name ?? '';
            const ticketName = ticket?.name ?? '';
            return {
              index: idx + 1,
              registrationId: reg.id,
              qrCode: reg.qrCode ?? reg.id,
              participantName: (reg.participantName ?? `${(reg.user ?? {}).firstName ?? ''} ${(reg.user ?? {}).lastName ?? ''}`.trim()) || 'Participante',
              // Cabeçalho do PDF: categoria (ou "Ingresso avulso") em destaque + nome abaixo.
              ticketCategory: catName || 'Ingresso avulso',
              ticketName: ticketName || '—',
              modality: [ticket?.modality, ticket?.distance ? `${ticket.distance}${ticket?.distanceUnit ? ` ${ticket.distanceUnit}` : ''}` : null].filter(Boolean).join(' ') || null,
              email: reg.participantEmail ?? user.email,
              cpf: reg.participantCpf ?? user.documentNumber,
              /* Nacionalidade. Prioridade:
               *   1. snapshot.participant.country — escolha por-participante.
               *   2. order.billingCountry — nacionalidade do checkout.
               *   3. reg.user.country — perfil base (fallback). */
              country:
                (reg.receiptSnapshot as any)?.participant?.country
                ?? order.billingCountry
                ?? reg.user?.country
                ?? null,
              /* documentType do snapshot tambem prevalece. PASSPORT explicito
               * salvo no checkout = estrangeiro confirmado. */
              documentType:
                (reg.receiptSnapshot as any)?.participant?.documentType
                ?? reg.user?.documentType
                ?? null,
              dateOfBirth: reg.participantDateOfBirth ?? user.dateOfBirth,
              phone: reg.participantPhone ?? user.phone,
              gender: reg.participantGender ?? user.gender,
              questionAnswers: (reg.questionAnswers ?? []).map((qa: any) => ({
                question: qa.question?.question ?? '',
                answer: formatPdfAnswer(qa.answer),
              })),
              products: (reg.products ?? []).map((rp: any) => ({
                name: rp.product?.name ?? rp.productSnapshot?.name ?? '',
                price: rp.unitPrice ?? 0,
                variationName: rp.variation?.name ?? rp.productSnapshot?.variationName,
                imageUrl: rp.product?.images?.[rp.product?.primaryImageIndex ?? 0],
                isIncluded: rp.product?.isIncludedInTicket ?? false,
              }))
              // "Sem interesse" = opt-out de produto opcional → não exibir no PDF.
              .filter((p: any) => p.variationName !== 'Sem interesse'),
            };
          }),
        };

        const eventName = event?.name ?? '';
        const eventLocation = event?.location ?? '';
        const eventDate = formatEventHappensDate(event?.eventDate);
        const eventAddress = formatEventCardAddress(event);
        const eventBannerUrl = event?.bannerUrl ?? 'https://placehold.co/308x232';

        // Comprador = primeira inscrição com conta vinculada
        // Comprador = dono do pedido. Pode nao ser participante (comprou so pra
        // terceiros) — busca o user direto nesse caso.
        let buyerUser = regs.find((r: any) => r.user?.id === order.userId)?.user;
        if (!buyerUser && order.userId) {
          buyerUser = await this.prisma.getReadClient().user.findUnique({
            where: { id: order.userId },
            select: { id: true, email: true, firstName: true, lastName: true },
          });
        }
        const buyerEmail: string | undefined = buyerUser?.email;

        // Gerar PDF individual por participante (sequencial — yoga-layout)
        type IndividualPdf = { pdf: Buffer | undefined; participantEmail: string | undefined; participantName: string };
        const individualPdfs: IndividualPdf[] = [];
        for (const [idx, reg] of regs.entries()) {
          const participantEmail: string | undefined = reg.participantEmail ?? reg.user?.email;
          const participantName: string = (reg.participantName
            ?? `${reg.user?.firstName ?? ''} ${reg.user?.lastName ?? ''}`.trim())
            || 'Participante';
          const regEntry = ticketPdfData.registrations[idx];
          if (!regEntry) { individualPdfs.push({ pdf: undefined, participantEmail, participantName }); continue; }
          const singlePdfData = {
            ...ticketPdfData,
            event: { ...ticketPdfData.event, participantCount: 1 },
            registrations: [{ ...regEntry, index: 1 }],
          };
          const pdf = await this.ticketPdfService.generateTicketPdf(singlePdfData)
            .catch((e: any) => { this.logger.warn(`PDF falhou para ${participantName}:`, e?.message); return undefined; });
          individualPdfs.push({ pdf, participantEmail, participantName });
        }

        // Envios SMTP em paralelo
        const emailPromises: Promise<unknown>[] = [];

        // Comprovante (recibo) do PEDIDO — anexado SÓ ao comprador. Mesmo builder
        // do download (`buildReceiptPdfData`) → documento idêntico.
        const receiptPdf = await this.receiptPdfService
          .generateReceiptPdf(buildReceiptPdfData(order))
          .catch((e: any) => { this.logger.warn(`Recibo PDF falhou para pedido ${orderId}:`, e?.message); return undefined; });

        // Comprador recebe todos os PDFs individuais como anexos separados
        if (buyerEmail) {
          const buyerPdfs = individualPdfs
            .filter(p => p.pdf)
            .map(p => ({ buffer: p.pdf as Buffer, participantName: p.participantName }));
          emailPromises.push(
            this.emailService.sendRegistrationConfirmed({
              email: buyerEmail,
              firstName: buyerUser?.firstName || 'Participante',
              eventName, eventLocation, eventDate, eventAddress, eventBannerUrl,
              ticketPdfs: buyerPdfs,
              receiptPdf,
            }).catch((err: any) => this.logger.warn('Email comprador falhou:', err)),
          );
        }

        // Participantes não-compradores recebem apenas seu próprio ingresso
        const invitedByFullName = `${buyerUser?.firstName ?? ''} ${buyerUser?.lastName ?? ''}`.trim();
        for (const p of individualPdfs) {
          if (!p.participantEmail || p.participantEmail === buyerEmail) continue;
          emailPromises.push(
            this.emailService.sendRegistrationConfirmed({
              email: p.participantEmail,
              firstName: p.participantName.split(' ')[0] || 'Participante',
              eventName, eventLocation, eventDate, eventAddress, eventBannerUrl,
              invitedByName: invitedByFullName || undefined,
              ticketPdfs: p.pdf ? [{ buffer: p.pdf, participantName: p.participantName }] : [],
            }).catch((err: any) => this.logger.warn(`Email participante ${p.participantEmail} falhou:`, err)),
          );
        }

        await Promise.allSettled(emailPromises);
      }).catch((err: any) => this.logger.warn('Failed to send registration confirmed emails:', err));
    }
  }

  /**
   * Handles the 3DS callback redirect from the bank after debit card authentication.
   * Queries Cielo for the definitive payment status, confirms the order if approved,
   * and returns the frontend redirect URL with the result.
   */
  async handle3dsCallback(orderId: string): Promise<string> {
    const frontendUrl = (process.env.FRONTEND_URL ?? '').replace(/\/$/, '');

    const payment = await this.prisma.getReadClient().payment.findFirst({
      where: { orderId, method: PaymentMethod.DEBIT_CARD },
    });

    if (!payment) {
      this.logger.warn(`3DS callback: no DEBIT_CARD payment found for order ${orderId}`);
      return `${frontendUrl}/checkout/${orderId}?3ds=error`;
    }

    if (payment.status === PaymentStatus.PAID) {
      return `${frontendUrl}/checkout/${orderId}?3ds=success`;
    }

    const meta = payment.metadata as any;
    const cieloPaymentId = meta?.cieloPaymentId as string | undefined;
    if (!cieloPaymentId) {
      this.logger.error(`3DS callback: missing cieloPaymentId in payment metadata for order ${orderId}`);
      return `${frontendUrl}/checkout/${orderId}?3ds=error`;
    }

    // In sandbox with a simulated payment, skip the Cielo query and treat as approved
    const isSandboxSimulated = (meta?.sandboxSimulated === true) || cieloPaymentId.startsWith('sandbox-3ds-');
    let paymentStatus: PaymentStatus;
    let cieloStatusStr: string;
    let cieloAuthCode: string | undefined;
    let cieloProofOfSale: string | undefined;

    if (isSandboxSimulated) {
      this.logger.log(`[SANDBOX] 3DS callback: bypassing Cielo query for simulated payment ${cieloPaymentId}`);
      paymentStatus = PaymentStatus.PAID;
      cieloStatusStr = 'PaymentConfirmed';
    } else {
      const cieloData = await this.cieloService.getPayment(cieloPaymentId);
      if (!cieloData) {
        this.logger.warn(`3DS callback: could not fetch Cielo payment ${cieloPaymentId}`);
        return `${frontendUrl}/checkout/${orderId}?3ds=error`;
      }
      const cieloStatusNum = cieloData.Payment.Status;
      paymentStatus = this.cieloService.mapCieloStatusToPaymentStatus(cieloStatusNum);
      cieloStatusStr = this.cieloService.mapCieloStatusToString(cieloStatusNum);
      cieloAuthCode = cieloData.Payment.AuthorizationCode;
      cieloProofOfSale = cieloData.Payment.ProofOfSale;
    }

    if (paymentStatus !== PaymentStatus.PAID) {
      const nextStatus = paymentStatus === PaymentStatus.FAILED ? PaymentStatus.FAILED : payment.status;
      await this.prisma.getWriteClient().payment.update({
        where: { id: payment.id },
        data: {
          status: nextStatus,
          metadata: { ...(meta as object), cieloStatus: cieloStatusStr, threeDsCallbackAt: new Date().toISOString() } as any,
        },
      });
      return `${frontendUrl}/checkout/${orderId}?3ds=failed`;
    }

    let confirmedOrderId: string | null = null;
    let orphanCancelledOrder = false;

    try {
      await this.prisma.$transaction(async (prisma) => {
        const updated = await prisma.payment.updateMany({
          where: { id: payment.id, status: { not: PaymentStatus.PAID } },
          data: {
            status: PaymentStatus.PAID,
            paymentDate: new Date(),
            metadata: {
              ...(meta as object),
              cieloStatus: cieloStatusStr,
              authorizationCode: cieloAuthCode,
              proofOfSale: cieloProofOfSale,
              threeDsCallbackAt: new Date().toISOString(),
            } as any,
          },
        });

        if (updated.count === 0) {
          // Already processed (duplicate callback)
          confirmedOrderId = orderId;
          return;
        }

        // Fonte ÚNICA: promove Order PENDING→PAID + finalize compartilhado.
        const { finalized, orderStatus } = await this.orderFinalization.confirmAndFinalizeOrder(prisma, orderId);
        if (!finalized) {
          this.logger.warn(`3DS callback: order ${orderId} não estava PENDING ao confirmar`);
          // CANCELLED = confirmado tarde demais (cron já cancelou) → compensa fora da tx.
          if (orderStatus === 'CANCELLED') orphanCancelledOrder = true;
          return;
        }

        confirmedOrderId = orderId;
        this.logger.log(`3DS callback confirmed order ${orderId}`);
      }, { timeout: 30000, maxWait: 10000 });
    } catch (err: unknown) {
      // Finalize abortado pós-captura (voucher consumido / participantes vazios): rollback
      // já desfez tudo; compensa com estorno automático e devolve "failed" pro front.
      if (err instanceof OrderFinalizationAbortError) {
        this.logger.error(`3DS callback: finalize abortado (${err.code}) para order ${err.orderId} — compensando com estorno automático`);
        await this.compensation.compensateOrphanPayment(err.orderId, err.code);
        return `${frontendUrl}/checkout/${orderId}?3ds=failed`;
      }
      throw err;
    }

    if (orphanCancelledOrder) {
      await this.compensation.compensateOrphanPayment(orderId, 'PAID_AFTER_CANCELLATION');
      return `${frontendUrl}/checkout/${orderId}?3ds=failed`;
    }

    if (confirmedOrderId) {
      this.gateway.emitPaymentConfirmed(confirmedOrderId);

      const oid = confirmedOrderId;
      this.prisma.getReadClient().order.findUnique({
        where: { id: oid },
        include: {
          // Comprador + reservedTickets: insumos do comprovante (recibo) do pedido.
          user: true,
          reservedTickets: true,
          event: { include: { organization: true } },
          payment: true,
          coupon: true,
          voucher: true,
          registrations: {
            include: {
              user: true,
              tickets: { include: { ticket: { include: { category: true } } } },
              products: { include: { product: true, variation: true } },
              questionAnswers: { include: { question: true } },
            },
          },
        },
      }).then(async (order: any) => {
        if (!order) return;
        const event = order.event;
        const org = event?.organization as { tradeName?: string | null; name?: string | null } | null;
        const orgName: string = org?.tradeName || org?.name || '';
        const regs: any[] = order.registrations ?? [];
        if (!regs.length) return;

        const issuedAt = new Date();
        const orderNumber = oid.slice(0, 8).toUpperCase();
        const buyerUserIdForEmail = order.userId as string | undefined;

        const ticketPdfData = {
          orderId: oid,
          orderNumber,
          issuedAt,
          event: {
            name: event?.name ?? '',
            date: event?.eventDate ?? new Date(),
            organization: orgName,
            location: formatEventCardAddress(event),
            participantCount: regs.length,
          },
          registrations: regs.map((reg: any, idx: number) => {
            // Sempre usa reg.user como fallback — convidado COM conta tem
            // participantX null mas dados em reg.user; zerar escondia a secao.
            const user = reg.user ?? {};
            const ticket = reg.tickets?.[0]?.ticket;
            const catName = ticket?.category?.name ?? '';
            const ticketName = ticket?.name ?? '';
            return {
              index: idx + 1,
              registrationId: reg.id,
              qrCode: reg.qrCode ?? reg.id,
              participantName: (reg.participantName ?? `${(reg.user ?? {}).firstName ?? ''} ${(reg.user ?? {}).lastName ?? ''}`.trim()) || 'Participante',
              // Cabeçalho do PDF: categoria (ou "Ingresso avulso") em destaque + nome abaixo.
              ticketCategory: catName || 'Ingresso avulso',
              ticketName: ticketName || '—',
              modality: [ticket?.modality, ticket?.distance ? `${ticket.distance}${ticket?.distanceUnit ? ` ${ticket.distanceUnit}` : ''}` : null].filter(Boolean).join(' ') || null,
              email: reg.participantEmail ?? user.email,
              cpf: reg.participantCpf ?? user.documentNumber,
              /* País do participante: usado pelo template do PDF para decidir
               * label do documento (CPF vs Documento) e aplicar/pular formatação.
               * Pegamos sempre do user real (não só isBuyerReg) — convidado sem
               * conta cai em null e o template assume BR. */
              /* Nacionalidade. Prioridade:
               *   1. snapshot.participant.country — escolha por-participante.
               *   2. order.billingCountry — nacionalidade do checkout.
               *   3. reg.user.country — perfil base (fallback). */
              country:
                (reg.receiptSnapshot as any)?.participant?.country
                ?? order.billingCountry
                ?? reg.user?.country
                ?? null,
              /* documentType do snapshot tambem prevalece. PASSPORT explicito
               * salvo no checkout = estrangeiro confirmado. */
              documentType:
                (reg.receiptSnapshot as any)?.participant?.documentType
                ?? reg.user?.documentType
                ?? null,
              dateOfBirth: reg.participantDateOfBirth ?? user.dateOfBirth,
              phone: reg.participantPhone ?? user.phone,
              gender: reg.participantGender ?? user.gender,
              questionAnswers: (reg.questionAnswers ?? []).map((qa: any) => ({
                question: qa.question?.question ?? '',
                answer: formatPdfAnswer(qa.answer),
              })),
              products: (reg.products ?? []).map((rp: any) => ({
                name: rp.product?.name ?? rp.productSnapshot?.name ?? '',
                price: rp.unitPrice ?? 0,
                variationName: rp.variation?.name ?? rp.productSnapshot?.variationName,
                imageUrl: rp.product?.images?.[rp.product?.primaryImageIndex ?? 0],
                isIncluded: rp.product?.isIncludedInTicket ?? false,
              }))
              // "Sem interesse" = opt-out de produto opcional → não exibir no PDF.
              .filter((p: any) => p.variationName !== 'Sem interesse'),
            };
          }),
        };

        const eventName = event?.name ?? '';
        const eventLocation = event?.location ?? '';
        const eventDate = formatEventHappensDate(event?.eventDate);
        const eventAddress = formatEventCardAddress(event);
        const eventBannerUrl = event?.bannerUrl ?? 'https://placehold.co/308x232';

        // Comprador = dono do pedido. Pode nao ser participante (comprou so pra
        // terceiros) — busca o user direto nesse caso.
        let buyerUser = regs.find((r: any) => r.user?.id === order.userId)?.user;
        if (!buyerUser && order.userId) {
          buyerUser = await this.prisma.getReadClient().user.findUnique({
            where: { id: order.userId },
            select: { id: true, email: true, firstName: true, lastName: true },
          });
        }
        const buyerEmail: string | undefined = buyerUser?.email;

        // Gerar PDF individual por participante (sequencial — yoga-layout)
        type IndividualPdf3ds = { pdf: Buffer | undefined; participantEmail: string | undefined; participantName: string };
        const individualPdfs3ds: IndividualPdf3ds[] = [];
        for (const [idx, reg] of regs.entries()) {
          const participantEmail: string | undefined = reg.participantEmail ?? reg.user?.email;
          const participantName: string = (reg.participantName
            ?? `${reg.user?.firstName ?? ''} ${reg.user?.lastName ?? ''}`.trim())
            || 'Participante';
          const regEntry = ticketPdfData.registrations[idx];
          if (!regEntry) { individualPdfs3ds.push({ pdf: undefined, participantEmail, participantName }); continue; }
          const singlePdfData = {
            ...ticketPdfData,
            event: { ...ticketPdfData.event, participantCount: 1 },
            registrations: [{ ...regEntry, index: 1 }],
          };
          const pdf = await this.ticketPdfService.generateTicketPdf(singlePdfData)
            .catch((e: any) => { this.logger.warn(`3DS PDF falhou para ${participantName}:`, e?.message); return undefined; });
          individualPdfs3ds.push({ pdf, participantEmail, participantName });
        }

        // Envios SMTP em paralelo
        const emailPromises3ds: Promise<unknown>[] = [];

        // Comprovante (recibo) do PEDIDO — anexado SÓ ao comprador. Mesmo builder
        // do download (`buildReceiptPdfData`) → documento idêntico.
        const receiptPdf3ds = await this.receiptPdfService
          .generateReceiptPdf(buildReceiptPdfData(order))
          .catch((e: any) => { this.logger.warn(`Recibo PDF (3DS) falhou para pedido ${oid}:`, e?.message); return undefined; });

        // Comprador recebe todos os PDFs individuais como anexos separados
        if (buyerEmail) {
          const buyerPdfs = individualPdfs3ds
            .filter(p => p.pdf)
            .map(p => ({ buffer: p.pdf as Buffer, participantName: p.participantName }));
          emailPromises3ds.push(
            this.emailService.sendRegistrationConfirmed({
              email: buyerEmail,
              firstName: buyerUser?.firstName || 'Participante',
              eventName, eventLocation, eventDate, eventAddress, eventBannerUrl,
              ticketPdfs: buyerPdfs,
              receiptPdf: receiptPdf3ds,
            }).catch((err: any) => this.logger.warn('3DS buyer email failed:', err)),
          );
        }

        // Participantes não-compradores recebem apenas seu próprio ingresso
        const invitedByFullName3ds = `${buyerUser?.firstName ?? ''} ${buyerUser?.lastName ?? ''}`.trim();
        for (const p of individualPdfs3ds) {
          if (!p.participantEmail || p.participantEmail === buyerEmail) continue;
          emailPromises3ds.push(
            this.emailService.sendRegistrationConfirmed({
              email: p.participantEmail,
              firstName: p.participantName.split(' ')[0] || 'Participante',
              eventName, eventLocation, eventDate, eventAddress, eventBannerUrl,
              invitedByName: invitedByFullName3ds || undefined,
              ticketPdfs: p.pdf ? [{ buffer: p.pdf, participantName: p.participantName }] : [],
            }).catch((err: any) => this.logger.warn(`3DS participant email failed for ${p.participantEmail}:`, err)),
          );
        }

        await Promise.allSettled(emailPromises3ds);
      }).catch((err: any) => this.logger.warn(`3DS email send failed for order ${oid}:`, err));
    }

    return `${frontendUrl}/checkout/${orderId}?3ds=success`;
  }
}
