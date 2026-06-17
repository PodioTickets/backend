import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { CieloService } from './cielo.service';
import { PaymentsWebhookService } from './payments-webhook.service';
import { PaymentsChargebackService } from './payments-chargeback.service';
import { PaymentsRefundService } from './payments-refund.service';
import { OrderFinalizationService } from './order-finalization.service';
import { PaymentCompensationService } from './payment-compensation.service';
import { PaymentGateway } from './payment.gateway';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from '../../common/services/email.service';
import { TicketPdfService } from '../../common/services/ticket-pdf.service';
import { ReceiptPdfService } from '../../common/services/receipt-pdf.service';
import { CommonModule } from '../../common/common.module';

@Module({
  // CommonModule exporta o UserActivityService (telemetria de funil: order.paid /
  // order.refunded / order.chargeback). Sem ciclo: CommonModule só importa ConfigModule.
  imports: [PrismaModule, ConfigModule, CommonModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    CieloService,
    PaymentsWebhookService,
    PaymentsChargebackService,
    PaymentsRefundService,
    OrderFinalizationService,
    PaymentCompensationService,
    PaymentGateway,
    EmailService,
    TicketPdfService,
    ReceiptPdfService,
  ],
  exports: [PaymentsService, CieloService, PaymentsRefundService, OrderFinalizationService, PaymentCompensationService],
})
export class PaymentsModule {}

