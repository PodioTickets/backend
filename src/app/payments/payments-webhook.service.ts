import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CieloService } from './cielo.service';
import { EmailService } from '../../common/services/email.service';
import { TicketPdfService } from '../../common/services/ticket-pdf.service';
import { PaymentGateway } from './payment.gateway';
import { PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';

function formatEventDate(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = new Date(date as string);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatEventAddress(event: any): string {
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

        // Marcar cupom/voucher como usados (mesmo padrão do pagamento por crédito)
        const paidOrder = await prisma.order.findUnique({
          where: { id: fresh.orderId },
          select: { couponId: true, voucherId: true, userId: true, reservedTickets: true },
        });
        if (paidOrder?.couponId) {
          const coupon = await prisma.coupon.findUnique({
            where: { id: paidOrder.couponId },
            select: { couponType: true, maxUsage: true, usageCount: true },
          });
          if (coupon) {
            const tickets = (paidOrder.reservedTickets ?? []) as any[];
            const ticketCount = tickets.reduce((s: number, rt: any) => s + (rt.quantity ?? 1), 0);
            const remaining = coupon.maxUsage != null
              ? Math.max(0, coupon.maxUsage - coupon.usageCount)
              : ticketCount;
            const increment = coupon.couponType === 'QUANTITY'
              ? 1
              : Math.min(remaining, ticketCount);
            if (increment > 0) {
              await prisma.coupon.update({
                where: { id: paidOrder.couponId },
                data: { usageCount: { increment } },
              });
            }
          }
        }
        if (paidOrder?.voucherId) {
          await prisma.voucher.update({
            where: { id: paidOrder.voucherId },
            data: { status: 'USED', usedAt: new Date(), usedBy: paidOrder.userId },
          });
        }

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

        // ID do comprador para distinguir inscrição própria de inscrição de convidado
        const buyerUserIdForPdf = regs.find((r: any) => r.user?.email)?.user?.id as string | undefined;

        // Build TicketPdfData
        const ticketPdfData = {
          orderId,
          orderNumber,
          issuedAt,
          event: {
            name: event?.name ?? '',
            date: event?.eventDate ?? new Date(),
            organization: orgName,
            location: formatEventAddress(event),
            participantCount: regs.length,
          },
          registrations: regs.map((reg: any, idx: number) => {
            const isBuyerReg = buyerUserIdForPdf && reg.user?.id === buyerUserIdForPdf && !reg.participantName;
            const user = isBuyerReg ? (reg.user ?? {}) : {};
            const ticket = reg.tickets?.[0]?.ticket;
            const catName = ticket?.category?.name ?? '';
            const ticketName = ticket?.name ?? '';
            const fullTicketName = catName && ticketName && catName !== ticketName
              ? `${catName} - ${ticketName}` : ticketName || catName;
            return {
              index: idx + 1,
              qrCode: reg.qrCode ?? reg.id,
              participantName: (reg.participantName ?? `${(reg.user ?? {}).firstName ?? ''} ${(reg.user ?? {}).lastName ?? ''}`.trim()) || 'Participante',
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

        const ticketPdf = await this.ticketPdfService.generateTicketPdf(ticketPdfData)
          .catch((e: any) => { this.logger.warn('Ticket PDF falhou:', e?.message); return undefined; });

        const eventName = event?.name ?? '';
        const eventLocation = event?.location ?? '';
        const eventDate = formatEventDate(event?.eventDate);
        const eventAddress = formatEventAddress(event);
        const eventBannerUrl = event?.logoUrl ?? event?.bannerUrl ?? 'https://placehold.co/308x232';

        // Comprador = primeira inscrição com conta vinculada — recebe todos os ingressos + recibo
        const buyerUser = regs.find((r: any) => r.user?.email)?.user;
        const buyerEmail: string | undefined = buyerUser?.email;

        if (buyerEmail) {
          await this.emailService.sendRegistrationConfirmed({
            email: buyerEmail,
            firstName: buyerUser?.firstName || 'Participante',
            eventName, eventLocation, eventDate, eventAddress, eventBannerUrl,
            ticketPdf: ticketPdf as Buffer | undefined,
          }).catch((err: any) => this.logger.warn('Email comprador falhou:', err));
        }

        // Participantes não-compradores — ingresso individual sem recibo, geração sequencial
        for (const [idx, reg] of regs.entries()) {
          const participantEmail: string | undefined = reg.participantEmail ?? reg.user?.email;
          if (!participantEmail || participantEmail === buyerEmail) continue;

          const participantName: string = (reg.participantName
            ?? `${reg.user?.firstName ?? ''} ${reg.user?.lastName ?? ''}`.trim())
            || 'Participante';
          const regEntry = ticketPdfData.registrations[idx];
          if (!regEntry) continue;

          const individualPdfData = {
            ...ticketPdfData,
            event: { ...ticketPdfData.event, participantCount: 1 },
            registrations: [{ ...regEntry, index: 1 }],
          };
          const individualTicketPdf = await this.ticketPdfService.generateTicketPdf(individualPdfData)
            .catch((e: any) => { this.logger.warn(`PDF individual falhou para ${participantEmail}:`, e?.message); return undefined; });

          await this.emailService.sendRegistrationConfirmed({
            email: participantEmail,
            firstName: participantName.split(' ')[0] || 'Participante',
            eventName, eventLocation, eventDate, eventAddress, eventBannerUrl,
            ticketPdf: individualTicketPdf as Buffer | undefined,
          }).catch((err: any) => this.logger.warn(`Email participante ${participantEmail} falhou:`, err));
        }
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

      const orderRows: any[] = await prisma.$queryRaw`
        UPDATE "Order"
        SET "status" = 'PAID'::"OrderStatus", "updatedAt" = NOW()
        WHERE id = ${orderId}::uuid AND "status" = 'PENDING'::"OrderStatus"
        RETURNING id
      `;

      if (!orderRows?.length) {
        this.logger.warn(`3DS callback: order ${orderId} was not PENDING when confirming`);
        return;
      }

      await prisma.registration.updateMany({
        where: { orderId, status: 'PENDING' },
        data: { status: 'CONFIRMED' },
      });

      await this.backfillTicketSnapshots(prisma, orderId);

      // Marcar cupom/voucher como usados
      const paidOrder3ds = await prisma.order.findUnique({
        where: { id: orderId },
        select: { couponId: true, voucherId: true, userId: true, reservedTickets: true },
      });
      if (paidOrder3ds?.couponId) {
        const coupon = await prisma.coupon.findUnique({
          where: { id: paidOrder3ds.couponId },
          select: { couponType: true, maxUsage: true, usageCount: true },
        });
        if (coupon) {
          const tickets = (paidOrder3ds.reservedTickets ?? []) as any[];
          const ticketCount = tickets.reduce((s: number, rt: any) => s + (rt.quantity ?? 1), 0);
          const remaining = coupon.maxUsage != null
            ? Math.max(0, coupon.maxUsage - coupon.usageCount)
            : ticketCount;
          const increment = coupon.couponType === 'QUANTITY' ? 1 : Math.min(remaining, ticketCount);
          if (increment > 0) {
            await prisma.coupon.update({
              where: { id: paidOrder3ds.couponId },
              data: { usageCount: { increment } },
            });
          }
        }
      }
      if (paidOrder3ds?.voucherId) {
        await prisma.voucher.update({
          where: { id: paidOrder3ds.voucherId },
          data: { status: 'USED', usedAt: new Date(), usedBy: paidOrder3ds.userId },
        });
      }

      confirmedOrderId = orderId;
      this.logger.log(`3DS callback confirmed order ${orderId}`);
    });

    if (confirmedOrderId) {
      this.gateway.emitPaymentConfirmed(confirmedOrderId);

      const oid = confirmedOrderId;
      this.prisma.getReadClient().order.findUnique({
        where: { id: oid },
        include: {
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
        const buyerUserIdForEmail = regs.find((r: any) => r.user?.email)?.user?.id as string | undefined;

        const ticketPdfData = {
          orderId: oid,
          orderNumber,
          issuedAt,
          event: {
            name: event?.name ?? '',
            date: event?.eventDate ?? new Date(),
            organization: orgName,
            location: formatEventAddress(event),
            participantCount: regs.length,
          },
          registrations: regs.map((reg: any, idx: number) => {
            const isBuyerReg = buyerUserIdForEmail && reg.user?.id === buyerUserIdForEmail && !reg.participantName;
            const user = isBuyerReg ? (reg.user ?? {}) : {};
            const ticket = reg.tickets?.[0]?.ticket;
            const catName = ticket?.category?.name ?? '';
            const ticketName = ticket?.name ?? '';
            const fullTicketName = catName && ticketName && catName !== ticketName
              ? `${catName} - ${ticketName}` : ticketName || catName;
            return {
              index: idx + 1,
              qrCode: reg.qrCode ?? reg.id,
              participantName: (reg.participantName ?? `${(reg.user ?? {}).firstName ?? ''} ${(reg.user ?? {}).lastName ?? ''}`.trim()) || 'Participante',
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

        const ticketPdf = await this.ticketPdfService.generateTicketPdf(ticketPdfData)
          .catch((e: any) => { this.logger.warn('Ticket PDF failed for 3DS order:', e?.message); return undefined; });

        const eventName = event?.name ?? '';
        const eventLocation = event?.location ?? '';
        const eventDate = formatEventDate(event?.eventDate);
        const eventAddress = formatEventAddress(event);
        const eventBannerUrl = event?.logoUrl ?? event?.bannerUrl ?? 'https://placehold.co/308x232';

        const buyerUser = regs.find((r: any) => r.user?.email)?.user;
        const buyerEmail: string | undefined = buyerUser?.email;

        if (buyerEmail) {
          await this.emailService.sendRegistrationConfirmed({
            email: buyerEmail,
            firstName: buyerUser?.firstName || 'Participante',
            eventName, eventLocation, eventDate, eventAddress, eventBannerUrl,
            ticketPdf: ticketPdf as Buffer | undefined,
          }).catch((err: any) => this.logger.warn('3DS buyer email failed:', err));
        }

        for (const [idx, reg] of regs.entries()) {
          const participantEmail: string | undefined = reg.participantEmail ?? reg.user?.email;
          if (!participantEmail || participantEmail === buyerEmail) continue;

          const participantName: string = (reg.participantName
            ?? `${reg.user?.firstName ?? ''} ${reg.user?.lastName ?? ''}`.trim())
            || 'Participante';
          const regEntry = ticketPdfData.registrations[idx];
          if (!regEntry) continue;

          const individualPdfData = {
            ...ticketPdfData,
            event: { ...ticketPdfData.event, participantCount: 1 },
            registrations: [{ ...regEntry, index: 1 }],
          };
          const individualTicketPdf = await this.ticketPdfService.generateTicketPdf(individualPdfData)
            .catch((e: any) => { this.logger.warn(`3DS PDF failed for ${participantEmail}:`, e?.message); return undefined; });

          await this.emailService.sendRegistrationConfirmed({
            email: participantEmail,
            firstName: participantName.split(' ')[0] || 'Participante',
            eventName, eventLocation, eventDate, eventAddress, eventBannerUrl,
            ticketPdf: individualTicketPdf as Buffer | undefined,
          }).catch((err: any) => this.logger.warn(`3DS participant email failed for ${participantEmail}:`, err));
        }
      }).catch((err: any) => this.logger.warn(`3DS email send failed for order ${oid}:`, err));
    }

    return `${frontendUrl}/checkout/${orderId}?3ds=success`;
  }
}
