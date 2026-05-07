import { Module } from '@nestjs/common';
import { AdminRepasseService } from './admin-repasse.service';
import { AdminRepasseController } from './admin-repasse.controller';
import { AdminAuthController } from './admin-auth.controller';
import { AdminEventsService } from './admin-events.service';
import { AdminEventsController } from './admin-events.controller';
import { AdminOrganizationsService } from './admin-organizations.service';
import { AdminOrganizationsController } from './admin-organizations.controller';
import { AdminNotificationsController } from './admin-notifications.controller';
import { AdminGuard } from '../auth/guards/admin.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { UploadModule } from '../upload/upload.module';
import { RepasseModule } from '../repasse/repasse.module';
import { EventsModule } from '../events/events.module';
import { EmailService } from '../../common/services/email.service';

@Module({
  imports: [PrismaModule, UploadModule, RepasseModule, EventsModule],
  controllers: [
    AdminRepasseController,
    AdminAuthController,
    AdminEventsController,
    AdminOrganizationsController,
    AdminNotificationsController,
  ],
  providers: [AdminRepasseService, AdminEventsService, AdminOrganizationsService, AdminGuard, EmailService],
})
export class AdminModule {}
