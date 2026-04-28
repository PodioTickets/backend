import { Module } from '@nestjs/common';
import { RepasseService } from './repasse.service';
import { RepasseController } from './repasse.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from '../../common/services/email.service';

@Module({
  imports: [PrismaModule, OrganizationsModule, ConfigModule],
  controllers: [RepasseController],
  providers: [RepasseService, EmailService],
  exports: [RepasseService],
})
export class RepasseModule {}
