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
  Header,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Request as ExpressRequest } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiBody,
  ApiProduces,
} from '@nestjs/swagger';
import { plainToClass } from 'class-transformer';
import { validate } from 'class-validator';
import { EventsService } from './events.service';
import { FiscalExportService } from './fiscal-export.service';
import {
  FiscalExportQueryDto,
  FiscalOrdersQueryDto,
} from './dto/fiscal-export.dto';
import { Throttle } from '@nestjs/throttler';
import {
  CreateEventDto,
  UpdateEventDto,
  FilterEventsDto,
  SearchEventsDto,
  SearchEventLocationsDto,
} from './dto/create-event.dto';
import {
  CreateEventTopicDto,
  UpdateEventTopicDto,
  ReorderEventTopicsDto,
  CreateEventLocationDto,
} from './dto/event-topic.dto';
import { DashboardOverviewQueryDto } from './dashboard/dto/overview.dto';
import { DashboardRankingsQueryDto } from './dashboard/dto/rankings.dto';
import { DashboardSecondaryQueryDto } from './dashboard/dto/secondary.dto';
import { DashboardService } from './dashboard/dashboard.service';
import { FinancialQueryDto } from './dto/financial.dto';
import { RegistrationsQueryDto } from './dto/registrations.dto';
import { ExportRegistrationsDto, EXPORT_FIELDS } from './dto/export-registrations.dto';
import { ExportRegistrationsService } from './export-registrations.service';
import { UpdateEventAdsTrackingDto } from './dto/event-ads-tracking.dto';
import {
  UpdateFinancialSettingsDto,
  FinancialSettingsDataWrapperDto,
  FinancialSettingsLockedErrorDto,
} from './dto/financial-settings.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { CacheTTL, NoCache } from 'src/common/decorators/cache.decorator';
import { getClientIp as clientIp } from '../../common/utils/client-ip.util';

function baseUrl(req: ExpressRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || '';
  return `${proto}://${host}`;
}

@ApiTags('Events')
@Controller('api/v1/events')
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly exportService: ExportRegistrationsService,
    private readonly fiscalExportService: FiscalExportService,
    private readonly dashboardService: DashboardService,
  ) { }

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

  @Get('search/locations')
  @CacheTTL(300_000)
  @Header('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=120')
  @ApiOperation({
    summary: 'Facetas de local (estado → cidades)',
    description:
      'Agregação DISTINCT no banco: estados e cidades com pelo menos um evento que passaria pelos mesmos filtros opcionais de GET /search (sem state/city). Payload mínimo para filtros em cascata na home/busca.',
  })
  @ApiQuery({ name: 'q', required: false, description: 'Igual ao search: restringe facetas a eventos que batem na busca textual' })
  @ApiQuery({ name: 'country', required: false })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT', 'PUBLISHED', 'SUSPENDED', 'CANCELLED', 'COMPLETED'] })
  @ApiQuery({ name: 'includePast', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Árvore estado → cidades ordenada (pt-BR)' })
  searchLocations(@Query() dto: SearchEventLocationsDto) {
    return this.eventsService.searchLocationFacets(dto);
  }

  @Get('search')
  @CacheTTL(120_000)
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
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'Get event by slug',
    description:
      'Retrieves a single event by its slug. Organizador/admin autenticado (OWNER/EMPLOYEE da org ou admin) recebe o payload COMPLETO (catálogo de ingressos/produtos + organização inteira); demais recebem o contrato público enxuto.',
  })
  @ApiParam({ name: 'slug', description: 'Event slug' })
  @ApiResponse({ status: 200, description: 'Event retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  findBySlug(@Request() req, @Param('slug') slug: string) {
    const userId = req.user?.id;
    return this.eventsService.findBySlug(slug, userId);
  }

  @Get(':id')
  @NoCache()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'Get event by ID',
    description:
      'Retrieves a single event by its ID. Quando autenticado como organizador (OWNER/EMPLOYEE da org do evento) ou admin, retorna também `registrationsCount` (inscrições confirmadas).',
  })
  @ApiParam({ name: 'id', description: 'Event UUID' })
  @ApiResponse({ status: 200, description: 'Event retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  findOne(@Request() req, @Param('id') id: string) {
    const userId = req.user?.id;
    return this.eventsService.findOne(id, userId);
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

  // ── GET /events/:eventId/tickets-management ───────────────────────────────
  // Bundle agregado que substitui (event + categories + tickets) em 1 round-trip.
  // Consumido pela página /organizer/events/:eventId/edit/tickets do frontend.
  @Get(':eventId/tickets-management')
  @UseGuards(JwtAuthGuard)
  @NoCache()
  @ApiBearerAuth()
  // Sem Cache-Control explícito → o SecurityHeadersInterceptor aplica `no-store` por default.
  // (Antes era `private, max-age=10`, que deixava o NAVEGADOR servir dado velho por 10s ao
  // reabrir a página de edição de ingressos logo após salvar.)
  @ApiOperation({
    summary: 'Tickets management bundle',
    description:
      'Retorna evento (subset), categorias e tickets em uma única chamada. ' +
      'Requer permissão edit_event sobre o evento.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'ticketsPage', required: false, type: Number, description: 'Página (default 1)' })
  @ApiQuery({ name: 'ticketsLimit', required: false, type: Number, description: 'Itens por página (default 500)' })
  @ApiResponse({ status: 200, description: 'Bundle retornado com sucesso' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — sem permissão sobre o evento' })
  @ApiResponse({ status: 404, description: 'Evento não encontrado' })
  getTicketsManagementBundle(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('eventId') eventId: string,
    @Query('ticketsPage') ticketsPage?: string,
    @Query('ticketsLimit') ticketsLimit?: string,
  ) {
    const pageNum = ticketsPage ? Math.max(1, Number.parseInt(ticketsPage, 10) || 1) : 1;
    const limitNum = ticketsLimit
      ? Math.min(500, Math.max(1, Number.parseInt(ticketsLimit, 10) || 500))
      : 500;
    return this.eventsService.getTicketsManagementBundle(req.user.id, eventId, {
      ticketsPage: pageNum,
      ticketsLimit: limitNum,
      baseUrl: baseUrl(req),
    });
  }

  @Get(':eventId/tracking')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @NoCache()
  @ApiOperation({
    summary: 'Get event ads / analytics tracking IDs',
    description:
      'Meta Pixel, GA4 e Google Ads (organizador). Não incluído em respostas públicas do evento.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiResponse({ status: 200, description: 'Tracking IDs retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  getAdsTracking(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('eventId') eventId: string,
  ) {
    return this.eventsService.getAdsTracking(req.user.id, eventId);
  }

  @Patch(':eventId/tracking')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @NoCache()
  @ApiOperation({
    summary: 'Update event ads / analytics tracking IDs',
    description:
      'PATCH parcial: apenas campos enviados são atualizados. String vazia remove o ID.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiBody({ type: UpdateEventAdsTrackingDto })
  @ApiResponse({ status: 200, description: 'Tracking updated' })
  @ApiResponse({ status: 400, description: 'Validation error or nothing to update' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  updateAdsTracking(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('eventId') eventId: string,
    @Body() body: UpdateEventAdsTrackingDto,
  ) {
    return this.eventsService.updateAdsTracking(req.user.id, eventId, body);
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

  @Patch(':eventId/topics/reorder')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Reorder event topics',
    description:
      'Define a ordem de todos os tópicos em uma única requisição. Envie `topicIds` na ordem desejada (cada id deve existir no evento, sem duplicar).',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiBody({ type: ReorderEventTopicsDto })
  @ApiResponse({ status: 200, description: 'Topics reordered successfully' })
  @ApiResponse({ status: 400, description: 'Invalid topicIds payload' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  reorderTopics(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('eventId') eventId: string,
    @Body() body: ReorderEventTopicsDto,
  ) {
    return this.eventsService.reorderTopics(req.user.id, eventId, body);
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

  @Get(':eventId/financial-settings')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @NoCache()
  @ApiOperation({
    summary: 'Buscar configurações financeiras do evento',
    description:
      'Retorna a divisão da taxa de plataforma (6%) entre organizador e participante, ' +
      'o número máximo de parcelas e os métodos de pagamento aceitos. ' +
      '`lockedAt` fica null até a publicação do evento; após a publicação, nenhuma alteração é permitida.',
  })
  @ApiParam({ name: 'eventId', type: 'string', format: 'uuid', description: 'UUID do evento' })
  @ApiResponse({ status: 200, description: 'Configurações financeiras do evento', type: FinancialSettingsDataWrapperDto })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 403, description: 'Sem permissão (não é o organizador do evento)' })
  @ApiResponse({ status: 404, description: 'Evento não encontrado' })
  getFinancialSettings(@Request() req, @Param('eventId') eventId: string) {
    return this.eventsService.getFinancialSettings(req.user.id, eventId);
  }

  @Patch(':eventId/financial-settings')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Atualizar configurações financeiras do evento',
    description:
      'Atualiza a divisão da taxa da plataforma (`organizerFeePercent`) e o parcelamento máximo (`maxInstallments`). ' +
      'A taxa total da plataforma é sempre 6%; `participantFeePercent = 6 - organizerFeePercent`. ' +
      'Retorna 409 se o evento já foi publicado (configurações bloqueadas).',
  })
  @ApiParam({ name: 'eventId', type: 'string', format: 'uuid', description: 'UUID do evento' })
  @ApiBody({ type: UpdateFinancialSettingsDto })
  @ApiResponse({ status: 200, description: 'Configurações financeiras atualizadas', type: FinancialSettingsDataWrapperDto })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 403, description: 'Sem permissão (não é o organizador do evento)' })
  @ApiResponse({ status: 404, description: 'Evento não encontrado' })
  @ApiResponse({
    status: 409,
    description: 'FINANCIAL_SETTINGS_LOCKED — configurações bloqueadas após publicação do evento',
    type: FinancialSettingsLockedErrorDto,
  })
  updateFinancialSettings(
    @Request() req,
    @Param('eventId') eventId: string,
    @Body() dto: UpdateFinancialSettingsDto,
  ) {
    return this.eventsService.updateFinancialSettings(req.user.id, eventId, dto, { bypassLock: req.user.role === 'ADMIN' });
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

  // ========== DASHBOARD (split em 3 rotas — overview/rankings/secondary) ==========

  /**
   * Above-the-fold: KPIs + gráfico de tendência. Cache 30s.
   *
   * `Cache-Control: private` — dados de organizador específico, NUNCA cachear em CDN/proxy.
   * `max-age=30` espelha o TTL do Redis. `stale-while-revalidate=60` deixa o browser
   * servir stale por mais 60s enquanto refaz em background — UX fluida no organizador
   * que volta pra aba do dashboard.
   */
  @Get(':eventId/dashboard/overview')
  @NoCache()
  @Header('Cache-Control', 'private, max-age=30, stale-while-revalidate=60')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get dashboard overview (KPIs + trend chart)' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'period', required: false, enum: ['geral', '24h', '7d', '15d', '1m', '2m'] })
  @ApiQuery({ name: 'ticketIds', required: false, type: [String] })
  @ApiResponse({ status: 200, description: 'Overview fetched successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async getDashboardOverview(
    @Request() req,
    @Param('eventId') eventId: string,
    @Query() rawQuery: any,
  ) {
    const queryDto = await this.parseDashboardQuery(DashboardOverviewQueryDto, rawQuery);
    return this.dashboardService.getOverview(req.user.id, eventId, queryDto);
  }

  /**
   * Tabelas paginadas: ticketRanking, tickets, topProductVariations, lotsNearDepletion. Cache 30s.
   */
  @Get(':eventId/dashboard/rankings')
  @NoCache()
  @Header('Cache-Control', 'private, max-age=30, stale-while-revalidate=60')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get dashboard rankings (paginated tables)' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'period', required: false, enum: ['geral', '24h', '7d', '15d', '1m', '2m'] })
  @ApiQuery({ name: 'ticketIds', required: false, type: [String] })
  @ApiQuery({ name: 'ticketRankingPage', required: false, type: Number, description: 'Default 1' })
  @ApiQuery({ name: 'ticketRankingLimit', required: false, type: Number, description: 'Default 10, max 100' })
  @ApiQuery({ name: 'ticketsPage', required: false, type: Number, description: 'Default 1' })
  @ApiQuery({ name: 'ticketsLimit', required: false, type: Number, description: 'Default 20, max 100' })
  @ApiResponse({ status: 200, description: 'Rankings fetched successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async getDashboardRankings(
    @Request() req,
    @Param('eventId') eventId: string,
    @Query() rawQuery: any,
  ) {
    const queryDto = await this.parseDashboardQuery(DashboardRankingsQueryDto, rawQuery);
    return this.dashboardService.getRankings(req.user.id, eventId, queryDto);
  }

  /**
   * Widgets secundários: topCities, salesHeatmap, mostAnsweredQuestions. Cache 60s.
   * TTL maior (dados mudam mais devagar).
   */
  @Get(':eventId/dashboard/secondary')
  @NoCache()
  @Header('Cache-Control', 'private, max-age=60, stale-while-revalidate=120')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get dashboard secondary widgets (geo + heatmap + Q&A)' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'period', required: false, enum: ['geral', '24h', '7d', '15d', '1m', '2m'] })
  @ApiQuery({ name: 'ticketIds', required: false, type: [String] })
  @ApiResponse({ status: 200, description: 'Secondary widgets fetched successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async getDashboardSecondary(
    @Request() req,
    @Param('eventId') eventId: string,
    @Query() rawQuery: any,
  ) {
    const queryDto = await this.parseDashboardQuery(DashboardSecondaryQueryDto, rawQuery);
    return this.dashboardService.getSecondary(req.user.id, eventId, queryDto);
  }

  /**
   * Normaliza `ticketIds[]` → `ticketIds`, transforma e valida o DTO de qualquer
   * rota do dashboard. Centraliza a lógica duplicada nos 3 handlers.
   */
  private async parseDashboardQuery<T extends object>(
    dtoClass: new () => T,
    rawQuery: any,
  ): Promise<T> {
    const normalized: any = { ...rawQuery };
    if (rawQuery['ticketIds[]']) {
      normalized.ticketIds = Array.isArray(rawQuery['ticketIds[]'])
        ? rawQuery['ticketIds[]']
        : [rawQuery['ticketIds[]']];
      delete normalized['ticketIds[]'];
    }
    const dto = plainToClass(dtoClass, normalized);
    const errors = await validate(dto as object);
    if (errors.length > 0) throw new BadRequestException('Falha na validação');
    return dto;
  }

  @Get(':eventId/questions/:questionId/text-answers')
  @NoCache()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get text answers for a question',
    description: 'Retrieves individual text/number answers with participant info for a specific question. Fetched lazily when the organizer opens question details.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'questionId', description: 'Question UUID' })
  @ApiResponse({ status: 200, description: 'Text answers fetched successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can access' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  getQuestionTextAnswers(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('questionId') questionId: string,
  ) {
    return this.eventsService.getQuestionTextAnswers(req.user.id, eventId, questionId);
  }

  // ========== FINANCIAL ==========
  @Get(':eventId/financial')
  @UseGuards(JwtAuthGuard)
  @NoCache()
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
  @NoCache()
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

  @Get(':eventId/financial/transfers/:withdrawalId')
  @UseGuards(JwtAuthGuard)
  @NoCache()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get transfer by ID',
    description: 'Retrieves a specific withdrawal request by ID. Only accessible by organizers with financial permission.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'withdrawalId', description: 'Withdrawal UUID' })
  @ApiResponse({ status: 200, description: 'Transfer fetched successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Transfer not found' })
  getFinancialTransferById(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('withdrawalId') withdrawalId: string,
  ) {
    return this.eventsService.getFinancialTransferById(req.user.id, eventId, withdrawalId);
  }

  @Get(':eventId/financial/installments')
  @UseGuards(JwtAuthGuard)
  @NoCache()
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
  @NoCache()
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
  @NoCache()
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
  @NoCache()
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

  // ========== FISCAL EXPORT ==========
  @Get(':eventId/financial/fiscal-orders')
  @UseGuards(JwtAuthGuard)
  @NoCache()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List fiscal orders (paid)',
    description: 'Paginated list of PAID orders for the fiscal export drawer. Requires financial permission.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max 50.' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Order ID prefix, buyer name or CPF (masked or unmasked).' })
  @ApiQuery({ name: 'period', required: false, enum: ['7d', '15d', '30d', '60d', 'all'] })
  @ApiQuery({ name: 'valueRange', required: false, enum: ['all', 'lt100', '100to500', '500to1000', 'gt1000'] })
  @ApiResponse({ status: 200, description: 'Fiscal orders fetched successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden — financial permission required' })
  getFiscalOrders(
    @Request() req,
    @Param('eventId') eventId: string,
    @Query() queryDto: FiscalOrdersQueryDto,
  ) {
    return this.fiscalExportService.getFiscalOrders(req.user.id, eventId, queryDto);
  }

  @Get(':eventId/financial/fiscal-export')
  @UseGuards(JwtAuthGuard)
  @NoCache()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Export fiscal data (txt/xlsx/pdf)',
    description: 'Generates a downloadable file with selected columns for the fiscal export. Rate limited to 5/min/user.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'format', required: false, enum: ['txt', 'xlsx', 'pdf'], description: 'Default: txt' })
  @ApiQuery({ name: 'fields', required: false, type: String, description: 'CSV of fields (whitelist validated)' })
  @ApiQuery({ name: 'orderIds', required: false, type: String, description: 'CSV of order UUIDs (overrides other filters)' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'period', required: false, enum: ['7d', '15d', '30d', '60d', 'all'] })
  @ApiQuery({ name: 'valueRange', required: false, enum: ['all', 'lt100', '100to500', '500to1000', 'gt1000'] })
  @ApiProduces('text/csv', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiResponse({ status: 200, description: 'File generated successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden — financial permission required' })
  @ApiResponse({ status: 413, description: 'Payload Too Large — refine filters (>100k rows)' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — limite 5/min' })
  async exportFiscalData(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('eventId') eventId: string,
    @Query() queryDto: FiscalExportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const result = await this.fiscalExportService.exportFiscalData(
      req.user.id,
      eventId,
      queryDto,
      clientIp(req),
    );
    res.setHeader('Content-Type', result.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    res.setHeader('Content-Length', String(result.buffer.length));
    return new StreamableFile(result.buffer);
  }

  // ========== ORDERS (organizador) ==========
  @Get(':eventId/orders/:orderId')
  @UseGuards(JwtAuthGuard)
  @NoCache()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Obter pedido por ID',
    description:
      'Retorna um pedido do evento (valores, comprador, pagamento, endereço de cobrança e inscrições vinculadas). Apenas membros autorizados da organização.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'orderId', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Pedido retornado com sucesso' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Evento ou pedido não encontrado' })
  getOrganizerOrder(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('orderId') orderId: string,
  ) {
    return this.eventsService.getOrderForOrganizer(req.user.id, eventId, orderId);
  }

  @Get(':eventId/registrations/export')
  @UseGuards(JwtAuthGuard)
  @NoCache()
  @ApiBearerAuth()
  @ApiProduces(
    'text/plain',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/pdf',
  )
  @ApiOperation({
    summary: 'Export event registrations',
    description: `Exports all non-pending registrations for the event in the requested format.
The response is a binary file download with the appropriate Content-Type and Content-Disposition headers.

**Formats**
- \`txt\` → UTF-8 CSV with BOM (\`.csv\`), comma-separated
- \`excel\` → Excel workbook (\`.xlsx\`) — auto column widths, bold header row
- \`pdf\` → Landscape A4 PDF with paginated, zebra-striped table

**Access:** organizer members with \`dashboard\` permission or owner.`,
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({
    name: 'format',
    required: true,
    enum: ['txt', 'excel', 'pdf'],
    description: 'Output file format',
  })
  @ApiQuery({
    name: 'fields',
    required: false,
    type: String,
    description: `Comma-separated list of field IDs to include in the export.
Omit to export all 15 fields. Valid IDs:
\`nome\` \`email\` \`cpf\` \`dataNascimento\` \`telefone\` \`sexo\`
\`contatoEmergencia\` \`endereco\` \`ingresso\` \`produtosEscolhidos\`
\`perguntasRespostas\` \`dataPagamento\` \`status\` \`formaPagamento\` \`valorPago\`

Example: \`fields=nome,email,cpf,status,valorPago\``,
  })
  @ApiResponse({
    status: 200,
    description: 'Binary file download. Content-Type varies by format:\n- `text/plain` for TXT\n- `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` for Excel\n- `application/pdf` for PDF',
  })
  @ApiResponse({ status: 400, description: 'Invalid `format` value' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — user is not an organizer of this event' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  async exportRegistrations(
    @Request() req,
    @Param('eventId') eventId: string,
    @Query() query: ExportRegistrationsDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { format, fields: fieldsParam } = query;
    if (!['txt', 'excel', 'pdf'].includes(format)) {
      throw new BadRequestException('Formato de exportação inválido. Use txt, excel ou pdf.');
    }

    const { registrations, eventName } = await this.eventsService.getRegistrationsForExport(
      req.user.id,
      eventId,
      {
        search: query.search,
        status: query.status,
        ticketIds: query.ticketIds ? query.ticketIds.split(',').filter(Boolean) : undefined,
        startDate: query.startDate,
        endDate: query.endDate,
      },
    );
    const fields = this.exportService.parseFields(fieldsParam);

    const safeEventName = eventName.replace(/[^a-z0-9\-_áéíóúãõâêôçàüñ ]/gi, '').trim() || `evento-${eventId.slice(0, 8)}`;

    if (format === 'txt') {
      const buf = this.exportService.generateTxt(registrations, fields, eventName);
      res.set({
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeEventName}.csv"`,
      });
      return new StreamableFile(buf);
    }

    if (format === 'excel') {
      const buf = this.exportService.generateExcel(registrations, fields, eventName);
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${safeEventName}.xlsx"`,
      });
      return new StreamableFile(buf);
    }

    // pdf
    const buf = await this.exportService.generatePdf(registrations, fields, eventName);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeEventName}.pdf"`,
    });
    return new StreamableFile(buf);
  }

  @Get(':eventId/registrations')
  @UseGuards(JwtAuthGuard)
  @NoCache()
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
      throw new BadRequestException('Falha na validação');
    }

    return this.eventsService.getRegistrations(req.user.id, eventId, queryDto);
  }

  @Get(':eventId/registrations/stats')
  @UseGuards(JwtAuthGuard)
  @NoCache()
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

