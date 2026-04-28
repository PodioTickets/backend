import { Module } from '@nestjs/common';
import { AdminRepasseService } from './admin-repasse.service';
import { AdminRepasseController } from './admin-repasse.controller';
import { AdminAuthController } from './admin-auth.controller';
import { AdminEventsService } from './admin-events.service';
import { AdminEventsController } from './admin-events.controller';
import { AdminGuard } from '../auth/guards/admin.guard';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AdminRepasseController, AdminAuthController, AdminEventsController],
  providers: [AdminRepasseService, AdminEventsService, AdminGuard],
})
export class AdminModule {}
