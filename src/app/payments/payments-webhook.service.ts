import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CieloService } from './cielo.service';
import { PaymentStatus } from '@prisma/client';

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
      }

      this.logger.log(`Payment ${fresh.id} updated via webhook to status ${paymentStatus}`);
    });
  }
}
