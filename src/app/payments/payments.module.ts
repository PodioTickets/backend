import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { CieloService } from './cielo.service';
import { PaymentsWebhookService } from './payments-webhook.service';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from '../../common/services/email.service';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, CieloService, PaymentsWebhookService, EmailService],
  exports: [PaymentsService, CieloService],
})
export class PaymentsModule {}

