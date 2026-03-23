import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  Request,
  BadRequestException,
} from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { plainToClass } from 'class-transformer';
import { validate } from 'class-validator';
import { EventsService } from './events.service';
import { CreateEventDto, UpdateEventDto, FilterEventsDto, SearchEventsDto } from './dto/create-event.dto';
import { CreateEventTopicDto, UpdateEventTopicDto, CreateEventLocationDto } from './dto/event-topic.dto';
import { DashboardQueryDto } from './dto/dashboard.dto';
import { FinancialQueryDto } from './dto/financial.dto';
import { RegistrationsQueryDto } from './dto/registrations.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NoCache } from 'src/common/decorators/cache.decorator';

function clientIp(req: ExpressRequest): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  if (Array.isArray(xff) && xff[0]) {
    return String(xff[0]).split(',')[0].trim();
  }
  return (req as ExpressRequest & { ip?: string }).ip || '';
}

@ApiTags('Events')
@Controller('api/v1/events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new event', description: 'Creates a new event for the authenticated organizer' })
  @ApiBody({ type: CreateEventDto })
  @ApiResponse({ status: 201, description: 'Event created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - User must be an organizer' })
  create(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Body() createEventDto: CreateEventDto,
  ) {
    return this.eventsService.create(
      req.user.id,
      createEventDto,
      clientIp(req),
    );
  }

  @Get('search')
  @ApiOperation({ 
    summary: 'Search events', 
    description: 'Advanced search for events with text search, location filters, and date ranges. Optimized for performance.' 
  })
  @ApiQuery({ name: 'q', required: false, description: 'Search query (searches in name, description, location, city, state)' })
  @ApiQuery({ name: 'country', required: false, description: 'Filter by country' })
  @ApiQuery({ name: 'state', required: false, description: 'Filter by state' })
  @ApiQuery({ name: 'city', required: false, description: 'Filter by city' })
  @ApiQuery({ name: 'startDate', required: false, description: 'Filter events from date (ISO string)' })
  @ApiQuery({ name: 'endDate', required: false, description: 'Filter events to date (ISO string)' })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT', 'PUBLISHED', 'SUSPENDED', 'CANCELLED', 'COMPLETED'], description: 'Filter by event status' })
  @ApiQuery({ name: 'includePast', required: false, type: Boolean, description: 'Include past events (default: false)' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20, max: 100)' })
  @ApiResponse({ status: 200, description: 'Events search completed successfully' })
  search(@Query() searchDto: SearchEventsDto) {
    return this.eventsService.search(searchDto);
  }

  @Get()
  @NoCache()
  @ApiOperation({
    summary: 'Get all events',
    description:
      'Public listing with optional filters. Suspended events are never returned. Default status when omitted is PUBLISHED only.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description:
      'Filter by event status. SUSPENDED is ignored (always excluded). Default when omitted: PUBLISHED.',
  })
  @ApiQuery({ name: 'country', required: false, description: 'Filter by country' })
  @ApiQuery({ name: 'state', required: false, description: 'Filter by state' })
  @ApiQuery({ name: 'city', required: false, description: 'Filter by city' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'Filter events from date' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'Filter events to date' })
  @ApiQuery({ name: 'includeDraft', required: false, description: 'Include draft events (only for organizers)' })
  @ApiQuery({ name: 'includePast', required: false, description: 'Include past events (default: false, only future events)' })
  @ApiQuery({
    name: 'includeHasSlots',
    required: false,
    type: Boolean,
    description:
      'Incluir hasRegistrationSlotsAvailable em cada evento (default: true). Use false para omitir o cálculo e reduzir carga no banco.',
  })
  @ApiResponse({ status: 200, description: 'Events retrieved successfully' })
  findAll(@Request() req, @Query() filterDto: FilterEventsDto) {
    const userId = req.user?.id;
    return this.eventsService.findAll(filterDto, userId);
  }

  @Get('slug/:slug')
  @NoCache()
  @ApiOperation({ summary: 'Get event by slug', description: 'Retrieves a single event by its slug (URL-friendly identifier)' })
  @ApiParam({ name: 'slug', description: 'Event slug' })
  @ApiResponse({ status: 200, description: 'Event retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  findBySlug(@Param('slug') slug: string) {
    return this.eventsService.findBySlug(slug);
  }

  @Get(':id')
  @NoCache()
  @ApiOperation({ summary: 'Get event by ID', description: 'Retrieves a single event by its ID' })
  @ApiParam({ name: 'id', description: 'Event UUID' })
  @ApiResponse({ status: 200, description: 'Event retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  findOne(@Param('id') id: string) {
    return this.eventsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update event', description: 'Updates an event. Only the event organizer can update it.' })
  @ApiParam({ name: 'id', description: 'Event UUID' })
  @ApiBody({ type: UpdateEventDto })
  @ApiResponse({ status: 200, description: 'Event updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can update' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  update(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('id') id: string,
    @Body() updateEventDto: UpdateEventDto,
  ) {
    return this.eventsService.update(
      req.user.id,
      id,
      updateEventDto,
      clientIp(req),
    );
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete event', description: 'Deletes an event. Only the event organizer can delete it.' })
  @ApiParam({ name: 'id', description: 'Event UUID' })
  @ApiResponse({ status: 200, description: 'Event deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can delete' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  remove(@Request() req, @Param('id') id: string) {
    return this.eventsService.remove(req.user.id, id);
  }

  // Event Topics
  @Post(':eventId/topics')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create event topic', description: 'Creates a new topic for an event' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiBody({ type: CreateEventTopicDto })
  @ApiResponse({ status: 201, description: 'Topic created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can create topics' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  createTopic(@Request() req, @Param('eventId') eventId: string, @Body() createTopicDto: CreateEventTopicDto) {
    return this.eventsService.createTopic(req.user.id, eventId, createTopicDto);
  }

  @Patch(':eventId/topics/:topicId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update event topic', description: 'Updates an event topic' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'topicId', description: 'Topic UUID' })
  @ApiBody({ type: UpdateEventTopicDto })
  @ApiResponse({ status: 200, description: 'Topic updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can update topics' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  updateTopic(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('topicId') topicId: string,
    @Body() updateTopicDto: UpdateEventTopicDto,
  ) {
    return this.eventsService.updateTopic(req.user.id, eventId, topicId, updateTopicDto);
  }

  @Delete(':eventId/topics/:topicId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete event topic', description: 'Deletes an event topic' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'topicId', description: 'Topic UUID' })
  @ApiResponse({ status: 200, description: 'Topic deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can delete topics' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  deleteTopic(@Request() req, @Param('eventId') eventId: string, @Param('topicId') topicId: string) {
    return this.eventsService.deleteTopic(req.user.id, eventId, topicId);
  }

  // Event Locations
  @Post(':eventId/locations')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create event location', description: 'Creates a new location for an event' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiBody({ type: CreateEventLocationDto })
  @ApiResponse({ status: 201, description: 'Location created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can create locations' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  createLocation(@Request() req, @Param('eventId') eventId: string, @Body() createLocationDto: CreateEventLocationDto) {
    return this.eventsService.createLocation(req.user.id, eventId, createLocationDto);
  }

  @Patch(':eventId/locations/:locationId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update event location', description: 'Updates an event location' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'locationId', description: 'Location UUID' })
  @ApiBody({ type: CreateEventLocationDto })
  @ApiResponse({ status: 200, description: 'Location updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can update locations' })
  @ApiResponse({ status: 404, description: 'Location not found' })
  updateLocation(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('locationId') locationId: string,
    @Body() updateLocationDto: CreateEventLocationDto,
  ) {
    return this.eventsService.updateLocation(req.user.id, eventId, locationId, updateLocationDto);
  }

  @Delete(':eventId/locations/:locationId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete event location', description: 'Deletes an event location' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'locationId', description: 'Location UUID' })
  @ApiResponse({ status: 200, description: 'Location deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can delete locations' })
  @ApiResponse({ status: 404, description: 'Location not found' })
  deleteLocation(@Request() req, @Param('eventId') eventId: string, @Param('locationId') locationId: string) {
    return this.eventsService.deleteLocation(req.user.id, eventId, locationId);
  }

  @Post(':eventId/publish')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Publish event',
    description: 'Publishes an event. Validates that event has required data before publishing.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiResponse({ status: 200, description: 'Event published successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - validation failed' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can publish events' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  publish(@Request() req, @Param('eventId') eventId: string) {
    return this.eventsService.publish(req.user.id, eventId);
  }

  @Post(':eventId/suspend')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Suspender evento',
    description:
      'Suspende um evento publicado: some das listagens públicas e bloqueia novas inscrições. Membros da organização (OWNER/EMPLOYEE) podem executar.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiResponse({ status: 200, description: 'Evento suspenso' })
  @ApiResponse({ status: 400, description: 'Evento não está publicado' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Apenas membros da organização do evento',
  })
  @ApiResponse({ status: 404, description: 'Event not found' })
  suspend(@Request() req, @Param('eventId') eventId: string) {
    return this.eventsService.suspend(req.user.id, eventId);
  }

  @Post(':eventId/resume')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Reativar evento suspenso',
    description:
      'Volta o status para PUBLISHED após suspensão. Para publicar pela primeira vez, use POST .../publish.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiResponse({ status: 200, description: 'Evento reativado' })
  @ApiResponse({ status: 400, description: 'Evento não está suspenso' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Apenas membros da organização do evento',
  })
  @ApiResponse({ status: 404, description: 'Event not found' })
  resumePublished(@Request() req, @Param('eventId') eventId: string) {
    return this.eventsService.resumePublished(req.user.id, eventId);
  }

  @Get(':eventId/stats')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get event statistics',
    description: 'Retrieves statistics for an event (registrations, revenue, tickets sold, etc.)',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiResponse({ status: 200, description: 'Event statistics retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can view statistics' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  getStats(@Request() req, @Param('eventId') eventId: string) {
    return this.eventsService.getStats(req.user.id, eventId);
  }

  @Get(':eventId/revenue')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get event revenue',
    description: 'Retrieves revenue breakdown for an event by modality',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiResponse({ status: 200, description: 'Event revenue retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can view revenue' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  getRevenue(@Request() req, @Param('eventId') eventId: string) {
    return this.eventsService.getRevenue(req.user.id, eventId);
  }

  // ========== DASHBOARD ==========
  @Get(':eventId/dashboard')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get event dashboard',
    description: 'Retrieves comprehensive dashboard data for an event including metrics, trends, rankings, and heatmaps. Only organization owner can access.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'period', required: false, enum: ['geral', '24h', '7d', '15d', '1m', '2m'], description: 'Time period filter' })
  @ApiQuery({ name: 'ticketIds', required: false, type: [String], description: 'Filter by ticket IDs' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number for rankings (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 10)' })
  @ApiResponse({ status: 200, description: 'Dashboard data fetched successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organization owner can access' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  async getDashboard(
    @Request() req,
    @Param('eventId') eventId: string,
    @Query() rawQuery: any,
  ) {
    // Normalizar ticketIds[] para ticketIds antes da validação
    const normalizedQuery: any = { ...rawQuery };
    if (rawQuery['ticketIds[]']) {
      normalizedQuery.ticketIds = Array.isArray(rawQuery['ticketIds[]'])
        ? rawQuery['ticketIds[]']
        : [rawQuery['ticketIds[]']];
      delete normalizedQuery['ticketIds[]'];
    }
    
    // Transformar e validar manualmente para evitar erro de whitelist
    const queryDto = plainToClass(DashboardQueryDto, normalizedQuery);
    const errors = await validate(queryDto);
    if (errors.length > 0) {
      throw new BadRequestException('Validation failed');
    }
    
    return this.eventsService.getDashboard(req.user.id, eventId, queryDto);
  }

  // ========== FINANCIAL ==========
  @Get(':eventId/financial')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get event financial data',
    description: 'Retrieves financial summary, revenue chart, and tickets table. Only organization owner can access.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'period', required: false, enum: ['hoje', '7d', '15d', '1m', '2m'], description: 'Time period filter' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20)' })
  @ApiResponse({ status: 200, description: 'Financial data fetched successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organization owner can access' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  getFinancial(@Request() req, @Param('eventId') eventId: string, @Query() queryDto: FinancialQueryDto) {
    return this.eventsService.getFinancial(req.user.id, eventId, queryDto);
  }

  @Get(':eventId/financial/transfers')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get transfer history',
    description: 'Retrieves history of financial transfers. Only organization owner can access.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiResponse({ status: 200, description: 'Transfer history fetched successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organization owner can access' })
  getFinancialTransfers(@Request() req, @Param('eventId') eventId: string) {
    return this.eventsService.getFinancialTransfers(req.user.id, eventId);
  }

  @Get(':eventId/financial/installments')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get installments to receive',
    description: 'Retrieves pending installments. Only organization owner can access.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiResponse({ status: 200, description: 'Installments fetched successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organization owner can access' })
  getFinancialInstallments(@Request() req, @Param('eventId') eventId: string) {
    return this.eventsService.getFinancialInstallments(req.user.id, eventId);
  }

  @Get(':eventId/financial/pending')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get pending releases',
    description: 'Retrieves amounts awaiting release. Only organization owner can access.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20, max: 100)' })
  @ApiResponse({ status: 200, description: 'Pending releases fetched successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organization owner can access' })
  getFinancialPending(
    @Request() req,
    @Param('eventId') eventId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.eventsService.getFinancialPending(req.user.id, eventId, page || 1, limit || 20);
  }

  @Get(':eventId/financial/refunded')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get refunded payments',
    description: 'Retrieves list of refunded payments. Only organization owner can access.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20, max: 100)' })
  @ApiResponse({ status: 200, description: 'Refunded payments fetched successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organization owner can access' })
  getFinancialRefunded(
    @Request() req,
    @Param('eventId') eventId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.eventsService.getFinancialRefunded(req.user.id, eventId, page || 1, limit || 20);
  }

  @Get(':eventId/financial/chargebacks')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get chargebacks',
    description: 'Retrieves list of chargebacks. Only organization owner can access.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20, max: 100)' })
  @ApiResponse({ status: 200, description: 'Chargebacks fetched successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organization owner can access' })
  getFinancialChargebacks(
    @Request() req,
    @Param('eventId') eventId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.eventsService.getFinancialChargebacks(req.user.id, eventId, page || 1, limit || 20);
  }

  // ========== REGISTRATIONS ==========
  @Get(':eventId/registrations')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get event registrations',
    description: 'Retrieves registrations with advanced filters, search, and pagination. Only organization owner can access.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20, max: 100)' })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'CHARGEBACK', 'REFUNDED'], description: 'Filter by status' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Search by name, CPF, email, or order ID' })
  @ApiQuery({ name: 'ticketIds', required: false, type: [String], description: 'Filter by ticket IDs' })
  @ApiQuery({ name: 'startDate', required: false, type: String, description: 'Start date (ISO string)' })
  @ApiQuery({ name: 'endDate', required: false, type: String, description: 'End date (ISO string)' })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['purchaseDate', 'amount', 'status'], description: 'Sort field' })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'], description: 'Sort order (default: desc)' })
  @ApiResponse({ status: 200, description: 'Registrations fetched successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organization owner can access' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  async getRegistrations(@Request() req, @Param('eventId') eventId: string, @Query() rawQuery: any) {
    const normalizedQuery: any = { ...rawQuery };
    if (rawQuery['ticketIds[]']) {
      normalizedQuery.ticketIds = Array.isArray(rawQuery['ticketIds[]'])
        ? rawQuery['ticketIds[]']
        : [rawQuery['ticketIds[]']];
      delete normalizedQuery['ticketIds[]'];
    }
    
    // Transformar e validar manualmente para evitar erro de whitelist
    const queryDto = plainToClass(RegistrationsQueryDto, normalizedQuery);
    const errors = await validate(queryDto);
    if (errors.length > 0) {
      throw new BadRequestException('Validation failed');
    }
    
    return this.eventsService.getRegistrations(req.user.id, eventId, queryDto);
  }

  @Get(':eventId/registrations/stats')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get registration statistics',
    description: 'Retrieves aggregated registration statistics. Only organization owner can access.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiResponse({ status: 200, description: 'Registration stats fetched successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organization owner can access' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  getRegistrationStats(@Request() req, @Param('eventId') eventId: string) {
    return this.eventsService.getRegistrationStats(req.user.id, eventId);
  }
}

