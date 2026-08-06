import { Module } from '@nestjs/common';
import { RegistrationsService } from './registrations.service';
import { RegistrationsController } from './registrations.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { KitsModule } from '../kits/kits.module';
import { PaymentsModule } from '../payments/payments.module';
import { CommonModule } from '../../common/common.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { EmailService } from '../../common/services/email.service';
import { TicketPdfService } from '../../common/services/ticket-pdf.service';

@Module({
  imports: [PrismaModule, KitsModule, PaymentsModule, CommonModule, OrganizationsModule],
  controllers: [RegistrationsController],
  providers: [RegistrationsService, EmailService, TicketPdfService],
  exports: [RegistrationsService],
})
export class RegistrationsModule {}

