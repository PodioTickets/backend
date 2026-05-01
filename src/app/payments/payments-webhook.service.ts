import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CieloService } from './cielo.service';
import { EmailService } from '../../common/services/email.service';
import { TicketPdfService } from '../../common/services/ticket-pdf.service';
import { ReceiptPdfService } from '../../common/services/receipt-pdf.service';
import { PaymentGateway } from './payment.gateway';
import { PaymentStatus, Prisma } from '@prisma/client';

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
    private readonly emailService: EmailService,
    private readonly ticketPdfService: TicketPdfService,
    private readonly receiptPdfService: ReceiptPdfService,
    private readonly gateway: PaymentGateway,
  ) {}

  /**
   * Fills in ticketSnapshot for RegistrationTicket rows that have none.
   * Called when a reservation-flow PIX/Boleto order is confirmed via webhook:
   * those registrations were created as PENDING placeholders without a snapshot.
   */
  private async backfillTicketSnapshots(prisma: any, orderId: string): Promise<void> {
    const regTickets = await prisma.registrationTicket.findMany({
      where: {
        registration: { orderId },
        ticketSnapshot: { equals: Prisma.JsonNull },
      },
      select: {
        id: true,
        ticketId: true,
        batchId: true,
      },
    });

    if (regTickets.length === 0) return;

    const ticketIds = [...new Set(regTickets.map((rt: any) => rt.ticketId as string))];
    const tickets = await prisma.ticket.findMany({
      where: { id: { in: ticketIds } },
      include: {
        category: { select: { id: true, name: true } },
        batches: { select: { id: true, price: true, sortOrder: true } },
      },
    });
    const ticketById = new Map<string, any>(tickets.map((t: any) => [t.id, t]));

    for (const rt of regTickets) {
      const t = ticketById.get(rt.ticketId);
      if (!t) continue;

      const batch = rt.batchId
        ? t.batches.find((b: any) => b.id === rt.batchId) ?? null
        : null;

      const ticketSnapshot = {
        id: t.id,
        name: t.name,
        description: t.description ?? null,
        modality: t.modality ?? null,
        distance: t.distance ?? null,
        distanceUnit: t.distanceUnit ?? null,
        gender: t.gender ?? null,
        ageLimitMin: t.ageLimitMin ?? null,
        ageLimitMax: t.ageLimitMax ?? null,
        category: t.category ?? null,
        batch: batch ? { id: batch.id, price: batch.price } : null,
        products: [],
      };

      await prisma.registrationTicket.update({
        where: { id: rt.id },
        data: { ticketSnapshot },
      });
    }

    this.logger.log(`Backfilled ticketSnapshot for ${regTickets.length} RegistrationTicket(s) on order ${orderId}`);
  }

  async handleWebhook(event: CieloWebhookEvent) {
    this.logger.log(`Processing Cielo webhook: PaymentId ${event.PaymentId}, Status ${event.Status}`);

    const paymentStatus = this.cieloService.mapCieloStatusToPaymentStatus(event.Status);

    // orderId capturado durante a transação para uso posterior (fora da transação)
    let confirmedOrderId: string | null = null;

    // Atualização atômica dentro de uma única transação.
    // updateMany com condição "status diferente do novo" garante que:
    //   • count=1 → este worker processou; prossegue com efeitos colaterais.
    //   • count=0 → outro worker já aplicou este status; ignora (idempotência).
    // Elimina a race condition entre webhooks duplicados ou entrega dupla.
    await this.prisma.$transaction(async (prisma) => {
      const updated = await prisma.payment.updateMany({
        where: {
          transactionId: event.PaymentId,
          status: { not: paymentStatus },
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
            cieloStatus: this.cieloService.mapCieloStatusToString(event.Status),
            webhookProcessedAt: new Date().toISOString(),
            returnCode: event.ReturnCode,
            returnMessage: event.ReturnMessage,
          } as any,
        },
      });

      if (paymentStatus === PaymentStatus.PAID) {
        await prisma.registration.updateMany({
          where: { orderId: fresh.orderId },
          data: { status: 'CONFIRMED' },
        });

        await this.backfillTicketSnapshots(prisma, fresh.orderId);

        // Captura orderId para envio de email fora da transação
        confirmedOrderId = fresh.orderId;
      }

      this.logger.log(`Payment ${fresh.id} updated via webhook to status ${paymentStatus}`);
    });

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

        // Build TicketPdfData
        const ticketPdfData = {
          orderNumber,
          issuedAt,
          event: {
            name: event?.name ?? '',
            date: event?.eventDate ?? new Date(),
            organization: orgName,
            location: event?.location ?? '',
            participantCount: regs.length,
          },
          registrations: regs.map((reg: any, idx: number) => {
            const user = reg.user ?? {};
            const ticket = reg.tickets?.[0]?.ticket;
            const catName = ticket?.category?.name ?? '';
            const ticketName = ticket?.name ?? '';
            const fullTicketName = catName && ticketName && catName !== ticketName
              ? `${catName} - ${ticketName}` : ticketName || catName;
            return {
              index: idx + 1,
              qrCode: reg.qrCode ?? reg.id,
              participantName: (reg.participantName ?? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()) || 'Participante',
              ticketName: fullTicketName,
              email: reg.participantEmail ?? user.email,
              cpf: reg.participantCpf ?? user.documentNumber,
              dateOfBirth: reg.participantDateOfBirth ?? user.dateOfBirth,
              phone: reg.participantPhone ?? user.phone,
              gender: reg.participantGender ?? user.gender,
              questionAnswers: (reg.questionAnswers ?? []).map((qa: any) => ({
                question: qa.question?.question ?? '',
                answer: qa.answer ?? '',
              })),
              products: (reg.products ?? []).map((rp: any) => ({
                name: rp.product?.name ?? rp.productSnapshot?.name ?? '',
                price: rp.unitPrice ?? 0,
                variationName: rp.variation?.name ?? rp.productSnapshot?.variationName,
                imageUrl: rp.product?.images?.[rp.product?.primaryImageIndex ?? 0],
                isIncluded: rp.product?.isIncludedInTicket ?? false,
              })),
            };
          }),
        };

        // Build ReceiptPdfData
        const payment = order.payment ?? {};
        const buyer = regs.find((r: any) => r.user)?.user ?? {};
        const receiptPdfData = {
          orderNumber,
          issuedAt,
          organization: { name: orgName, document: org.document, logoUrl: org.logoUrl ?? undefined },
          buyer: {
            name: `${buyer.firstName ?? ''} ${buyer.lastName ?? ''}`.trim() || 'Comprador',
            document: buyer.documentNumber,
          },
          event: {
            name: event?.name ?? '',
            date: event?.eventDate ?? new Date(),
            location: event?.location ?? '',
          },
          payment: {
            method: payment.method ?? 'PIX',
            paidAt: payment.paymentDate ?? payment.updatedAt ?? issuedAt,
            gateway: 'Cielo',
            transactionId: payment.transactionId,
            txId: (payment.metadata as any)?.txId,
            e2eId: (payment.metadata as any)?.e2eId,
            voucherCode: order.voucher?.code,
            couponCode: order.coupon?.code,
          },
          financial: {
            subtotal: order.totalAmount ?? 0,
            discount: order.discount ?? 0,
            voucherCode: order.voucher?.code,
            serviceFee: order.serviceFee ?? 0,
            total: order.finalAmount ?? 0,
          },
          registrations: regs.map((reg: any) => {
            const user = reg.user ?? {};
            const ticket = reg.tickets?.[0]?.ticket;
            const catName = ticket?.category?.name ?? '';
            const ticketName = ticket?.name ?? '';
            const batch = reg.tickets?.[0]?.batch;
            return {
              id: reg.id,
              participantName: (reg.participantName ?? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()) || 'Participante',
              email: reg.participantEmail ?? user.email,
              ticketCategory: catName || undefined,
              ticketName: ticketName || catName,
              price: batch?.price ?? 0,
            };
          }),
        };

        const ticketPdf = await this.ticketPdfService.generateTicketPdf(ticketPdfData).catch((e: any) => { this.logger.warn('Ticket PDF failed:', e?.message); return undefined; });
        const receiptPdf = await this.receiptPdfService.generateReceiptPdf(receiptPdfData).catch((e: any) => { this.logger.warn('Receipt PDF failed:', e?.message); return undefined; });

        // Send one email per unique buyer (group by email)
        const byEmail = new Map<string, { firstName: string; email: string }>();
        regs.forEach((reg: any) => {
          const email = reg.user?.email;
          if (email && !byEmail.has(email)) {
            byEmail.set(email, { email, firstName: reg.user?.firstName ?? '' });
          }
        });

        const sends = Array.from(byEmail.values()).map((b) =>
          this.emailService.sendRegistrationConfirmed({
            email: b.email,
            firstName: b.firstName,
            eventName: event?.name ?? '',
            eventLocation: event?.location ?? '',
            eventBannerUrl: event?.bannerUrl ?? 'https://placehold.co/308x232',
            ticketPdf: ticketPdf as Buffer | undefined,
            receiptPdf: receiptPdf as Buffer | undefined,
          }),
        );
        return Promise.all(sends);
      }).catch((err: any) => this.logger.warn('Failed to send registration confirmed emails:', err));
    }
  }
}
