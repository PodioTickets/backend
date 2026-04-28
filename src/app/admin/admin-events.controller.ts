import {
  Controller, Get, Query, UseGuards,
  DefaultValuePipe, ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags, ApiOperation, ApiBearerAuth,
  ApiQuery, ApiResponse,
} from '@nestjs/swagger';
import {
  IsEnum, IsISO8601, IsNumberString, IsOptional,
  IsString, IsUUID, IsIn,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { EventStatus } from '@prisma/client';
import { AdminEventsService } from './admin-events.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { NoCache } from 'src/common/decorators/cache.decorator';

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
}
