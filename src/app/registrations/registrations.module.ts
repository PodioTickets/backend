import { Module } from '@nestjs/common';
import { RegistrationsService } from './registrations.service';
import { RegistrationsController } from './registrations.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { KitsModule } from '../kits/kits.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [PrismaModule, KitsModule, PaymentsModule],
  controllers: [RegistrationsController],
  providers: [RegistrationsService],
  exports: [RegistrationsService],
})
export class RegistrationsModule {}

