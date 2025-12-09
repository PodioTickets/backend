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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { EventsService } from './events.service';
import { CreateEventDto, UpdateEventDto, FilterEventsDto, SearchEventsDto } from './dto/create-event.dto';
import { CreateEventTopicDto, UpdateEventTopicDto, CreateEventLocationDto } from './dto/event-topic.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

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
  create(@Request() req, @Body() createEventDto: CreateEventDto) {
    return this.eventsService.create(req.user.id, createEventDto);
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
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED'], description: 'Filter by event status' })
  @ApiQuery({ name: 'includePast', required: false, type: Boolean, description: 'Include past events (default: false)' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20, max: 100)' })
  @ApiResponse({ status: 200, description: 'Events search completed successfully' })
  search(@Query() searchDto: SearchEventsDto) {
    return this.eventsService.search(searchDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all events', description: 'Retrieves a list of events with optional filters' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by event status' })
  @ApiQuery({ name: 'country', required: false, description: 'Filter by country' })
  @ApiQuery({ name: 'state', required: false, description: 'Filter by state' })
  @ApiQuery({ name: 'city', required: false, description: 'Filter by city' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'Filter events from date' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'Filter events to date' })
  @ApiQuery({ name: 'includeDraft', required: false, description: 'Include draft events (only for organizers)' })
  @ApiQuery({ name: 'includePast', required: false, description: 'Include past events (default: false, only future events)' })
  @ApiResponse({ status: 200, description: 'Events retrieved successfully' })
  findAll(@Request() req, @Query() filterDto: FilterEventsDto) {
    const userId = req.user?.id;
    return this.eventsService.findAll(filterDto, userId);
  }

  @Get(':id')
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
  update(@Request() req, @Param('id') id: string, @Body() updateEventDto: UpdateEventDto) {
    return this.eventsService.update(req.user.id, id, updateEventDto);
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
}

