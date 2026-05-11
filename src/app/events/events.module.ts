import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { EventNotificationsService } from './event-notifications.service';
import { OrganizerEventNotificationsController } from './organizer-event-notifications.controller';
import { ExportRegistrationsService } from './export-registrations.service';
import { FiscalExportService } from './fiscal-export.service';
import { EmailService } from '../../common/services/email.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { TicketsModule } from '../tickets/tickets.module';
import { TicketCategoriesModule } from '../ticket-categories/ticket-categories.module';
import { RepasseModule } from '../repasse/repasse.module';
import { CommonModule } from '../../common/common.module';

@Module({
  imports: [PrismaModule, OrganizationsModule, TicketsModule, TicketCategoriesModule, ConfigModule, RepasseModule, CommonModule],
  controllers: [EventsController, OrganizerEventNotificationsController],
  providers: [EventsService, EventNotificationsService, ExportRegistrationsService, FiscalExportService, EmailService],
  exports: [EventsService, EventNotificationsService, ExportRegistrationsService, FiscalExportService],
})
export class EventsModule {}

