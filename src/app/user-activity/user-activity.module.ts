import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { UserActivityController } from './user-activity.controller';
import { UserActivityAdminController } from './user-activity-admin.controller';
import { UserActivityAdminService } from './user-activity-admin.service';
import { AdminGuard } from '../auth/guards/admin.guard';

/**
 * Módulo de telemetria de usuário.
 *
 * Dois controllers:
 *  - `UserActivityController` (`POST /me/activity/events`) — ingestão de
 *    eventos do frontend (anônimo-friendly).
 *  - `UserActivityAdminController` (`GET /admin/user-activity`) — leitura
 *    paginada para o painel admin.
 *
 * O `UserActivityService` (write-side, com buffer/flush) vive no
 * `CommonModule` por ser cross-cutting (interceptors em auth/orders/etc.).
 * O `UserActivityAdminService` (read-side) fica local porque só serve
 * esse controller.
 *
 * `AuthModule` provê a strategy do passport (usada pelo `JwtAuthGuard` e
 * `OptionalJwtAuthGuard`). `AdminGuard` é provider local porque depende
 * apenas de `PrismaService` (já global).
 */
@Module({
  imports: [CommonModule, AuthModule],
  controllers: [UserActivityController, UserActivityAdminController],
  providers: [UserActivityAdminService, AdminGuard],
})
export class UserActivityModule {}
