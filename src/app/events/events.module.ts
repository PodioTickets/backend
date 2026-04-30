import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { EventNotificationsService } from './event-notifications.service';
import { OrganizerEventNotificationsController } from './organizer-event-notifications.controller';
import { ExportRegistrationsService } from './export-registrations.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { TicketsModule } from '../tickets/tickets.module';

@Module({
  imports: [PrismaModule, OrganizationsModule, TicketsModule],
  controllers: [EventsController, OrganizerEventNotificationsController],
  providers: [EventsService, EventNotificationsService, ExportRegistrationsService],
  exports: [EventsService, EventNotificationsService, ExportRegistrationsService],
})
export class EventsModule {}

