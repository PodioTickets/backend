import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { NoCache } from '../../common/decorators/cache.decorator';
import { UserActivityAdminService } from './user-activity-admin.service';
import { AdminUserActivityListQueryDto } from './dto/admin-list-activity.dto';

/**
 * Listagem admin de atividade de usuário final. Endpoint paralelo (não
 * substitui) ao `/organizations/admin/audit-logs` — aquele cobre logs do
 * painel (operadores); este cobre clientes/anônimos.
 *
 * Proteção: `JwtAuthGuard + AdminGuard` (mesmo padrão das outras rotas
 * administrativas). `AdminGuard` valida `role IN (ADMIN, PODIOGO_STAFF)`.
 */
@ApiTags('Admin — User Activity')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/v1/admin/user-activity')
export class UserActivityAdminController {
  constructor(private readonly service: UserActivityAdminService) {}

  @Get()
  @NoCache()
  @ApiOperation({
    summary: '[ADMIN] List user activity logs',
    description:
      'Listagem paginada dos registros de UserActivityLog (cliente final + anônimo). Filtros combinados via AND. Ordenação fixa: `occurredAt` desc. Cobre tanto eventos do frontend (telemetria) quanto eventos capturados pelo backend (login, checkout, refund). Eventos anônimos retornam `userId: null` e `user: null`.',
  })
  @ApiQuery({ name: 'category', required: false, enum: ['PAGE_VIEW', 'CLICK', 'API', 'AUTH', 'CHECKOUT', 'PROFILE', 'COMPLIANCE', 'OTHER'] })
  @ApiQuery({ name: 'source', required: false, enum: ['FRONTEND', 'BACKEND', 'WEBHOOK'] })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'userSearch', required: false, description: 'Substring em first/last/email. Exclui anônimos.' })
  @ApiQuery({ name: 'sessionId', required: false })
  @ApiQuery({ name: 'ip', required: false })
  @ApiQuery({ name: 'q', required: false, description: 'Substring no campo action.' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200, description: 'Logs retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  async list(@Query() query: AdminUserActivityListQueryDto) {
    return this.service.listAsAdmin(query);
  }
}
