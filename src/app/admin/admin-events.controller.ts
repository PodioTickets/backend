import {
  Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards,
  DefaultValuePipe, ParseIntPipe, ParseUUIDPipe, Req,
} from '@nestjs/common';
import {
  ApiTags, ApiOperation, ApiBearerAuth,
  ApiQuery, ApiParam, ApiResponse,
} from '@nestjs/swagger';
import {
  IsEnum, IsISO8601, IsNumber, IsNumberString, IsOptional,
  IsString, IsUUID, IsIn, IsInt, Min, Max, IsArray, ArrayNotEmpty,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { EventStatus } from '@prisma/client';
import { AdminEventsService } from './admin-events.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { NoCache } from 'src/common/decorators/cache.decorator';

class AdminUpdateFinancialSettingsDto {
  @IsOptional() @IsNumber() @Min(0) organizerFeePercent?: number;
  @IsOptional() @IsNumber() @Min(0) participantFeePercent?: number;
  @IsOptional() @IsInt() @Min(1) maxInstallments?: number;
  @IsOptional() @IsNumber() @Min(0) totalFee?: number;
  // Taxas Podio↔organizador por evento (frações 0–1: 0.10 = 10%, 0.02 = 2%).
  @IsOptional() @IsNumber() @Min(0) @Max(1) retentionRate?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) refundFeeRate?: number;
}

class ReorderFeaturedDto {
  /** Conjunto EXATO de eventos em destaque, na nova ordem desejada. */
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  orderedIds!: string[];
}

class AdminEventsQueryDto {
  @IsOptional() @IsNumberString() page?: string;
  @IsOptional() @IsNumberString() limit?: string;

  @IsOptional() @IsString() search?: string;

  @IsOptional() @IsEnum(EventStatus) status?: EventStatus;

  @IsOptional() @IsUUID() organizationId?: string;

  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() country?: string;

  @IsOptional() @IsISO8601() eventDateFrom?: string;
  @IsOptional() @IsISO8601() eventDateTo?: string;

  @IsOptional() @IsISO8601() createdFrom?: string;
  @IsOptional() @IsISO8601() createdTo?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : undefined)
  hasAudit?: boolean;

  @IsOptional()
  @IsIn(['eventDate', 'createdAt', 'name', 'registrations', 'revenue'])
  sortBy?: 'eventDate' | 'createdAt' | 'name' | 'registrations' | 'revenue';

  @IsOptional() @IsIn(['asc', 'desc']) sortOrder?: 'asc' | 'desc';
}

@ApiTags('Admin — Events')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/v1/admin')
export class AdminEventsController {
  constructor(private readonly adminEventsService: AdminEventsService) {}

  @Get('events')
  @NoCache()
  @ApiOperation({ summary: '[Admin] Listagem global de eventos' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Busca por nome, slug, cidade ou organização' })
  @ApiQuery({ name: 'status', required: false, enum: EventStatus })
  @ApiQuery({ name: 'organizationId', required: false, type: String })
  @ApiQuery({ name: 'city', required: false, type: String })
  @ApiQuery({ name: 'state', required: false, type: String })
  @ApiQuery({ name: 'country', required: false, type: String })
  @ApiQuery({ name: 'eventDateFrom', required: false, type: String, description: 'ISO 8601' })
  @ApiQuery({ name: 'eventDateTo', required: false, type: String, description: 'ISO 8601' })
  @ApiQuery({ name: 'createdFrom', required: false, type: String, description: 'ISO 8601' })
  @ApiQuery({ name: 'createdTo', required: false, type: String, description: 'ISO 8601' })
  @ApiQuery({ name: 'hasAudit', required: false, type: Boolean, description: 'true = auditados, false = não auditados' })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['eventDate', 'createdAt', 'name', 'registrations', 'revenue'] })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  @ApiResponse({ status: 200, description: 'Lista de eventos com paginação e métricas' })
  getEvents(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query() query: AdminEventsQueryDto,
  ) {
    return this.adminEventsService.getEvents({
      page,
      limit: Math.min(limit, 100),
      search: query.search,
      status: query.status,
      organizationId: query.organizationId,
      city: query.city,
      state: query.state,
      country: query.country,
      eventDateFrom: query.eventDateFrom ? new Date(query.eventDateFrom) : undefined,
      eventDateTo: query.eventDateTo ? new Date(query.eventDateTo) : undefined,
      createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
      createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      hasAudit: query.hasAudit,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
  }

  @Get('events/revision')
  @NoCache()
  @ApiOperation({ summary: '[Admin] Lista eventos aguardando revisão (status REVISION)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Busca por nome, slug, cidade ou organização' })
  @ApiQuery({ name: 'organizationId', required: false, type: String, description: 'UUID da organização' })
  @ApiResponse({
    status: 200,
    description: 'Lista paginada de eventos em revisão',
    schema: {
      example: {
        message: 'Revision events fetched successfully',
        data: {
          events: [
            {
              id: 'evt-uuid',
              name: 'Corrida das Pedras 2026',
              slug: 'corrida-das-pedras-2026',
              status: 'REVISION',
              city: 'São Paulo',
              state: 'SP',
              eventDate: '2026-08-10T07:00:00.000Z',
              updatedAt: '2026-05-06T12:00:00.000Z',
              organization: { id: 'org-uuid', name: 'Events Co. LTDA', email: 'contato@eventsco.com' },
              _count: { registrations: 0, tickets: 3 },
            },
          ],
          pagination: { page: 1, limit: 20, total: 4, totalPages: 1 },
        },
      },
    },
  })
  getRevisionEvents(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search') search?: string,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.adminEventsService.getRevisionEvents(
      page,
      Math.min(limit, 100),
      search,
      organizationId,
    );
  }

  // ── Eventos em destaque (carrossel da home + prioridade na busca) ───────────
  // Rotas ESTÁTICAS (`events/featured`, `events/featured/order`) declaradas antes
  // das dinâmicas (`events/:eventId/...`) para não serem capturadas por elas.

  @Get('events/featured')
  @NoCache()
  @ApiOperation({ summary: '[Admin] Lista os eventos em destaque na ordem do carrossel' })
  @ApiResponse({ status: 200, description: 'Eventos em destaque' })
  listFeatured() {
    return this.adminEventsService.listFeatured();
  }

  @Patch('events/featured/order')
  @ApiOperation({ summary: '[Admin] Reordena o carrossel de destaque (orderedIds = conjunto atual)' })
  @ApiResponse({ status: 200, description: 'Ordem atualizada' })
  @ApiResponse({ status: 400, description: 'orderedIds não corresponde ao conjunto atual' })
  reorderFeatured(@Body() dto: ReorderFeaturedDto) {
    return this.adminEventsService.reorderFeatured(dto.orderedIds);
  }

  @Post('events/:eventId/featured')
  @ApiOperation({ summary: '[Admin] Adiciona o evento ao carrossel de destaque' })
  @ApiParam({ name: 'eventId', type: String, description: 'UUID do evento' })
  @ApiResponse({ status: 201, description: 'Evento adicionado ao destaque' })
  @ApiResponse({ status: 400, description: 'Evento não está publicado' })
  @ApiResponse({ status: 404, description: 'Evento não encontrado' })
  addFeatured(@Param('eventId', ParseUUIDPipe) eventId: string) {
    return this.adminEventsService.addFeatured(eventId);
  }

  @Delete('events/:eventId/featured')
  @ApiOperation({ summary: '[Admin] Remove o evento do carrossel de destaque' })
  @ApiParam({ name: 'eventId', type: String, description: 'UUID do evento' })
  @ApiResponse({ status: 200, description: 'Evento removido do destaque' })
  @ApiResponse({ status: 404, description: 'Evento não encontrado' })
  removeFeatured(@Param('eventId', ParseUUIDPipe) eventId: string) {
    return this.adminEventsService.removeFeatured(eventId);
  }

  @Post('events/:eventId/publish')
  @ApiOperation({ summary: '[Admin] Aprova evento em revisão → PUBLISHED e notifica organizador por e-mail' })
  @ApiParam({ name: 'eventId', type: String, description: 'UUID do evento' })
  @ApiResponse({
    status: 200,
    description: 'Evento publicado com sucesso',
    schema: {
      example: {
        message: 'Event approved and published successfully',
        data: {
          event: {
            id: 'evt-uuid',
            name: 'Corrida das Pedras 2026',
            status: 'PUBLISHED',
            financialSettingsLockedAt: '2026-05-06T14:30:00.000Z',
            updatedAt: '2026-05-06T14:30:00.000Z',
          },
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Evento não está em status REVISION' })
  @ApiResponse({ status: 404, description: 'Evento não encontrado' })
  approveEvent(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Req() req: any,
  ) {
    return this.adminEventsService.approveEvent(req.user.id, eventId);
  }

  @Patch('events/:eventId/financial-settings')
  @ApiOperation({ summary: '[Admin] Atualiza configurações financeiras do evento sem restrições' })
  @ApiParam({ name: 'eventId', type: String, description: 'UUID do evento' })
  @ApiResponse({ status: 200, description: 'Configurações financeiras atualizadas' })
  @ApiResponse({ status: 404, description: 'Evento não encontrado' })
  updateFinancialSettings(
    @Param('eventId') eventId: string,
    @Body() dto: AdminUpdateFinancialSettingsDto,
  ) {
    return this.adminEventsService.updateFinancialSettings(eventId, dto);
  }
}
