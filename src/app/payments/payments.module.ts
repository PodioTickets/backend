import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { CieloService } from './cielo.service';
import { PaymentsWebhookService } from './payments-webhook.service';
import { PaymentsChargebackService } from './payments-chargeback.service';
import { PaymentsRefundService } from './payments-refund.service';
import { PaymentGateway } from './payment.gateway';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from '../../common/services/email.service';
import { TicketPdfService } from '../../common/services/ticket-pdf.service';
import { RepasseModule } from '../repasse/repasse.module';

@Module({
  imports: [PrismaModule, ConfigModule, RepasseModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    CieloService,
    PaymentsWebhookService,
    PaymentsChargebackService,
    PaymentsRefundService,
    PaymentGateway,
    EmailService,
    TicketPdfService,
  ],
  exports: [PaymentsService, CieloService, PaymentsRefundService],
})
export class PaymentsModule {}

