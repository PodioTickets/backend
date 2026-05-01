import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { CieloService } from './cielo.service';
import { PaymentsWebhookService } from './payments-webhook.service';
import { PaymentGateway } from './payment.gateway';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from '../../common/services/email.service';
import { TicketPdfService } from '../../common/services/ticket-pdf.service';
import { ReceiptPdfService } from '../../common/services/receipt-pdf.service';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, CieloService, PaymentsWebhookService, PaymentGateway, EmailService, TicketPdfService, ReceiptPdfService],
  exports: [PaymentsService, CieloService],
})
export class PaymentsModule {}

