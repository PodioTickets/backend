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
import type { Request as ExpressRequest } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { TicketsService } from './tickets.service';
import {
  CreateTicketDto,
  UpdateTicketDto,
  FilterTicketsDto,
  ReorderTicketProductsDto,
  ReorderTicketsDto,
} from './dto/create-ticket.dto';
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

@ApiTags('Tickets')
@Controller('api/v1/tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) { }

  @Post('events/:eventId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create ticket',
    description: 'Creates a new ticket for an event',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiBody({ type: CreateTicketDto })
  @ApiResponse({ status: 201, description: 'Ticket created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - validation error' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can create tickets' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  create(@Request() req, @Param('eventId') eventId: string, @Body() createTicketDto: CreateTicketDto) {
    return this.ticketsService.create(req.user.id, eventId, createTicketDto);
  }

  @Get('events/:eventId')
  @NoCache()
  @ApiOperation({
    summary: 'List tickets',
    description: 'Retrieves all tickets for a specific event with optional filters',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'categoryId', required: false, type: String, description: 'Filter by category ID' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20)' })
  @ApiResponse({ status: 200, description: 'Tickets retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  findAll(@Param('eventId') eventId: string, @Query() filterDto: FilterTicketsDto) {
    return this.ticketsService.findAll(eventId, filterDto);
  }

  @Patch('events/:eventId/reorder-tickets')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Reorder tickets within a category or uncategorized',
    description:
      'Body lists every active ticket in that scope (same categoryId, or omit categoryId for tickets without category). Index in the array is the new sortOrder.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiBody({ type: ReorderTicketsDto })
  @ApiResponse({ status: 200, description: 'Tickets reordered successfully' })
  @ApiResponse({ status: 400, description: 'Invalid ticketIds (wrong set or duplicates)' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  reorderTickets(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('eventId') eventId: string,
    @Body() body: ReorderTicketsDto,
  ) {
    return this.ticketsService.reorderTickets(
      req.user.id,
      eventId,
      body,
      clientIp(req),
    );
  }

  @Get(':id')
  @NoCache()
  @ApiOperation({
    summary: 'Get ticket by ID',
    description: 'Retrieves a single ticket by its ID',
  })
  @ApiParam({ name: 'id', description: 'Ticket UUID' })
  @ApiResponse({ status: 200, description: 'Ticket retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  findOne(@Param('id') id: string) {
    return this.ticketsService.findOne(id);
  }

  @Patch('events/:eventId/:ticketId/products/reorder')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Reorder ticket products',
    description:
      'Updates display order only. Body must list every productId currently linked to the ticket, in the desired order (no additions or removals).',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'ticketId', description: 'Ticket UUID' })
  @ApiBody({ type: ReorderTicketProductsDto })
  @ApiResponse({ status: 200, description: 'Products reordered successfully' })
  @ApiResponse({ status: 400, description: 'Invalid productIds (wrong set or duplicates)' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  reorderTicketProducts(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('eventId') eventId: string,
    @Param('ticketId') ticketId: string,
    @Body() body: ReorderTicketProductsDto,
  ) {
    return this.ticketsService.reorderTicketProducts(
      req.user.id,
      eventId,
      ticketId,
      body,
      clientIp(req),
    );
  }

  @Patch('events/:eventId/:ticketId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update ticket',
    description: 'Updates a ticket. Cannot update tickets that have been sold.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'ticketId', description: 'Ticket UUID' })
  @ApiBody({ type: UpdateTicketDto })
  @ApiResponse({ status: 200, description: 'Ticket updated successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - validation error or ticket already sold' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can update tickets' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  update(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('eventId') eventId: string,
    @Param('ticketId') ticketId: string,
    @Body() updateTicketDto: UpdateTicketDto,
  ) {
    return this.ticketsService.update(
      req.user.id,
      eventId,
      ticketId,
      updateTicketDto,
      clientIp(req),
    );
  }

  @Delete('events/:eventId/:ticketId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete ticket',
    description: 'Deletes a ticket. Cannot delete tickets that have been sold.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'ticketId', description: 'Ticket UUID' })
  @ApiResponse({ status: 200, description: 'Ticket deleted successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - ticket already sold' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can delete tickets' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  remove(@Request() req, @Param('eventId') eventId: string, @Param('ticketId') ticketId: string) {
    return this.ticketsService.remove(req.user.id, eventId, ticketId);
  }

  @Post('events/:eventId/:ticketId/duplicate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Duplicate ticket',
    description: 'Creates a duplicate of an existing ticket with all its batches and products',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'ticketId', description: 'Ticket UUID to duplicate' })
  @ApiResponse({ status: 201, description: 'Ticket duplicated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can duplicate tickets' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  duplicate(@Request() req, @Param('eventId') eventId: string, @Param('ticketId') ticketId: string) {
    return this.ticketsService.duplicate(req.user.id, eventId, ticketId);
  }
}
