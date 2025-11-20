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

    const payment = await this.prisma.payment.findFirst({
      where: { transactionId: event.PaymentId },
      include: {
        registration: true,
      },
    });

    if (!payment) {
      this.logger.warn(`Payment not found for payment ID: ${event.PaymentId}`);
      return;
    }

    const paymentStatus = this.cieloService.mapCieloStatusToPaymentStatus(event.Status);

    // Atualizar apenas se o status mudou
    if (payment.status === paymentStatus) {
      this.logger.log(`Payment ${payment.id} already has status ${paymentStatus}`);
      return;
    }

    await this.prisma.$transaction(async (prisma) => {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: paymentStatus,
          paymentDate: paymentStatus === PaymentStatus.PAID ? new Date() : payment.paymentDate,
          metadata: {
            ...(payment.metadata as any),
            cieloStatus: this.cieloService.mapCieloStatusToString(event.Status),
            webhookProcessedAt: new Date().toISOString(),
            returnCode: event.ReturnCode,
            returnMessage: event.ReturnMessage,
          } as any,
        },
      });

      // Atualizar status da inscrição se pago
      if (paymentStatus === PaymentStatus.PAID) {
        await prisma.registration.update({
          where: { id: payment.registrationId },
          data: {
            status: 'CONFIRMED',
          },
        });
      }

      // Se falhou ou foi cancelado, manter a inscrição como pendente ou cancelar
      if (paymentStatus === PaymentStatus.FAILED || paymentStatus === PaymentStatus.REFUNDED) {
        // Não cancelar automaticamente a inscrição, apenas marcar o pagamento como falhou
        this.logger.log(`Payment ${payment.id} marked as ${paymentStatus}`);
      }
    });

    this.logger.log(`Payment ${payment.id} updated via webhook to status ${paymentStatus}`);
  }
}

