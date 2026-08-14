import { Module } from '@nestjs/common';
import { OrganizersService } from './organizers.service';
import { OrganizersController } from './organizers.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { EmailService } from '../../common/services/email.service';
import { WhatsAppService } from '../../common/services/whatsapp.service';
import { ConfigModule } from '@nestjs/config';
import { EventsModule } from '../events/events.module';
import { CommonModule } from '../../common/common.module';

@Module({
  imports: [PrismaModule, ConfigModule, EventsModule, CommonModule],
  controllers: [OrganizersController],
  providers: [OrganizersService, EmailService, WhatsAppService],
  exports: [OrganizersService],
})
export class OrganizersModule {}

