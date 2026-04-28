import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CieloService } from './cielo.service';
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
      }

      this.logger.log(`Payment ${fresh.id} updated via webhook to status ${paymentStatus}`);
    });
  }
}
