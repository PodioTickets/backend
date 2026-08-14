import { Module } from '@nestjs/common';
import { RepasseService } from './repasse.service';
import { RepasseController } from './repasse.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PaymentsModule } from '../payments/payments.module';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from '../../common/services/email.service';
import { CommonModule } from '../../common/common.module';

@Module({
  imports: [PrismaModule, OrganizationsModule, PaymentsModule, ConfigModule, CommonModule],
  controllers: [RepasseController],
  providers: [RepasseService, EmailService],
  exports: [RepasseService],
})
export class RepasseModule {}
