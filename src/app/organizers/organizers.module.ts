import { Module } from '@nestjs/common';
import { OrganizersService } from './organizers.service';
import { OrganizersController } from './organizers.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { EmailService } from '../../common/services/email.service';
import { WhatsAppService } from '../../common/services/whatsapp.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [OrganizersController],
  providers: [OrganizersService, EmailService, WhatsAppService],
  exports: [OrganizersService],
})
export class OrganizersModule {}

