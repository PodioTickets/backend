import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NoCache } from 'src/common/decorators/cache.decorator';
import { EventNotificationsService } from './event-notifications.service';
import {
  CreateEventNotificationDto,
  ListEventNotificationsQueryDto,
} from './dto/event-notification.dto';
import { getClientIp } from '../../common/utils/client-ip.util';

@ApiTags('Organizer Event Notifications')
@Controller('api/v1/organizer/events')
export class OrganizerEventNotificationsController {
  constructor(private readonly eventNotifications: EventNotificationsService) {}

  @Get(':eventId/notifications')
  @NoCache()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List event notifications (paginated)' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'q', required: false, description: 'Search in title' })
  @ApiQuery({ name: 'status', required: false, enum: ['review', 'sent', 'denied'] })
  @ApiResponse({ status: 200, description: 'List without messageHtml' })
  list(
    @Request() req: { user: { id: string } },
    @Param('eventId') eventId: string,
    @Query() query: ListEventNotificationsQueryDto,
  ) {
    return this.eventNotifications.list(req.user.id, eventId, query);
  }

  @Get(':eventId/notifications/:notificationId')
  @NoCache()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get notification detail with messageHtml' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'notificationId', description: 'Notification UUID' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404 })
  getOne(
    @Request() req: { user: { id: string } },
    @Param('eventId') eventId: string,
    @Param('notificationId') notificationId: string,
  ) {
    return this.eventNotifications.getOne(req.user.id, eventId, notificationId);
  }

  @Post(':eventId/notifications')
  @HttpCode(201)
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ long: { limit: 30, ttl: 60000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create event notification (registers as review)' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 400 })
  @ApiResponse({ status: 403 })
  create(
    @Request() req: { user: { id: string } },
    @Param('eventId') eventId: string,
    @Body() dto: CreateEventNotificationDto,
  ) {
    return this.eventNotifications.create(
      req.user.id,
      eventId,
      dto,
      getClientIp(req as any),
    );
  }
}
