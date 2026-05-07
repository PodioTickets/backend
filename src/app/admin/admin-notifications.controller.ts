import {
  Controller, Get, Post, Param, Query, Body,
  UseGuards, Req, DefaultValuePipe, ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags, ApiOperation, ApiBearerAuth,
  ApiQuery, ApiParam, ApiBody, ApiResponse,
} from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { EventNotificationsService } from '../events/event-notifications.service';
import { NoCache } from 'src/common/decorators/cache.decorator';

class AdminReviewNotificationDto {
  @IsIn(['approve', 'deny'])
  action: 'approve' | 'deny';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

@ApiTags('Admin — Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/v1/admin/notifications')
export class AdminNotificationsController {
  constructor(private readonly eventNotifications: EventNotificationsService) {}

  @Get()
  @NoCache()
  @ApiOperation({ summary: '[Admin] Lista notificações pendentes de revisão' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Busca no título' })
  @ApiQuery({ name: 'eventId', required: false, type: String, description: 'Filtrar por evento' })
  @ApiQuery({ name: 'status', required: false, enum: ['review', 'sent', 'denied'], description: 'Filtrar por status. Omitir retorna todos.' })
  @ApiResponse({
    status: 200,
    description: 'Lista paginada de notificações em revisão',
    schema: {
      example: {
        message: 'Notifications fetched successfully',
        data: {
          items: [
            {
              id: 'notif-uuid',
              title: 'Atualização importante',
              channels: ['email'],
              status: 'review',
              occurredAt: '2026-05-07T10:00:00.000Z',
              createdAt: '2026-05-07T10:00:00.000Z',
              event: {
                id: 'evt-uuid',
                name: 'Corrida das Pedras 2026',
                slug: 'corrida-das-pedras-2026',
                organization: { id: 'org-uuid', name: 'Events Co. LTDA', tradeName: 'Events Co.', logoUrl: null },
              },
              createdBy: { id: 'usr-uuid', firstName: 'João', lastName: 'Silva', email: 'joao@eventsco.com' },
            },
          ],
          pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
        },
      },
    },
  })
  list(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search') search?: string,
    @Query('eventId') eventId?: string,
    @Query('status') status?: string,
  ) {
    return this.eventNotifications.adminList(page, Math.min(limit, 100), search, eventId, status);
  }

  @Get(':notificationId')
  @NoCache()
  @ApiOperation({ summary: '[Admin] Detalhes de uma notificação (inclui messageHtml)' })
  @ApiParam({ name: 'notificationId', type: String })
  @ApiResponse({
    status: 200,
    description: 'Notificação com conteúdo HTML completo',
    schema: {
      example: {
        message: 'Notification fetched successfully',
        data: {
          id: 'notif-uuid',
          title: 'Atualização importante',
          channels: ['email'],
          status: 'review',
          messageHtml: '<p>Olá! Informamos que o percurso foi alterado...</p>',
          occurredAt: '2026-05-07T10:00:00.000Z',
          createdAt: '2026-05-07T10:00:00.000Z',
          event: {
            id: 'evt-uuid',
            name: 'Corrida das Pedras 2026',
            slug: 'corrida-das-pedras-2026',
            organization: { id: 'org-uuid', name: 'Events Co. LTDA', tradeName: 'Events Co.', logoUrl: null },
          },
          createdBy: { id: 'usr-uuid', firstName: 'João', lastName: 'Silva', email: 'joao@eventsco.com' },
        },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Notificação não encontrada' })
  getOne(@Param('notificationId') notificationId: string) {
    return this.eventNotifications.adminGetOne(notificationId);
  }

  @Post(':notificationId/review')
  @ApiOperation({ summary: '[Admin] Aprovar ou recusar notificação. Aprovação dispara envio imediato dos emails.' })
  @ApiParam({ name: 'notificationId', type: String })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['approve', 'deny'], example: 'deny' },
        reason: { type: 'string', maxLength: 500, nullable: true, example: 'O conteúdo não segue as diretrizes da plataforma.' },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Aprovada (emails disparados) ou recusada',
    schema: {
      example: {
        message: 'Notification approved and emails dispatched',
        data: { id: 'notif-uuid', status: 'sent', title: 'Atualização importante', channels: ['email'], occurredAt: '2026-05-07T10:00:00.000Z' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Notificação já foi processada' })
  @ApiResponse({ status: 404, description: 'Notificação não encontrada' })
  review(
    @Param('notificationId') notificationId: string,
    @Body() body: AdminReviewNotificationDto,
    @Req() req: any,
  ) {
    return this.eventNotifications.adminReview(req.user.id, notificationId, body.action, body.reason);
  }
}
