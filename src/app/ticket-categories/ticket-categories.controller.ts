import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Request } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { TicketCategoriesService } from './ticket-categories.service';
import {
  CreateTicketCategoryDto,
  UpdateTicketCategoryDto,
  ReorderTicketCategoriesDto,
} from './dto/create-ticket-category.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NoCache } from 'src/common/decorators/cache.decorator';
import { getClientIp } from '../../common/utils/client-ip.util';

@ApiTags('Ticket Categories')
@Controller('api/v1/tickets')
export class TicketCategoriesController {
  constructor(private readonly ticketCategoriesService: TicketCategoriesService) {}

  @Post('events/:eventId/categories')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create ticket category',
    description: 'Creates a new category for organizing tickets in an event',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiBody({ type: CreateTicketCategoryDto })
  @ApiResponse({ status: 201, description: 'Ticket category created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - Only organizer can create categories',
  })
  @ApiResponse({ status: 404, description: 'Event not found' })
  createCategory(
    @Request() req,
    @Param('eventId') eventId: string,
    @Body() createCategoryDto: CreateTicketCategoryDto,
  ) {
    return this.ticketCategoriesService.create(req.user.id, eventId, createCategoryDto, getClientIp(req));
  }

  @Get('events/:eventId/categories')
  @NoCache()
  @ApiOperation({
    summary: 'List ticket categories',
    description: 'Retrieves all ticket categories for a specific event',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiResponse({
    status: 200,
    description: 'Ticket categories retrieved successfully',
  })
  findAllCategories(@Param('eventId') eventId: string) {
    return this.ticketCategoriesService.findAll(eventId);
  }

  @Patch('events/:eventId/categories/reorder')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Reorder ticket categories',
    description:
      'Sets sortOrder from the order of categoryIds (same pattern as event topics / ticket products).',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiBody({ type: ReorderTicketCategoriesDto })
  @ApiResponse({ status: 200, description: 'Ticket categories reordered successfully' })
  @ApiResponse({ status: 400, description: 'Invalid categoryIds list' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  reorderCategories(
    @Request() req,
    @Param('eventId') eventId: string,
    @Body() body: ReorderTicketCategoriesDto,
  ) {
    return this.ticketCategoriesService.reorder(req.user.id, eventId, body, getClientIp(req));
  }

  @Patch('events/:eventId/categories/:categoryId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update ticket category',
    description: 'Updates a ticket category',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'categoryId', description: 'Category UUID' })
  @ApiBody({ type: UpdateTicketCategoryDto })
  @ApiResponse({ status: 200, description: 'Ticket category updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - Only organizer can update categories',
  })
  @ApiResponse({ status: 404, description: 'Category not found' })
  updateCategory(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('categoryId') categoryId: string,
    @Body() updateCategoryDto: UpdateTicketCategoryDto,
  ) {
    return this.ticketCategoriesService.update(req.user.id, eventId, categoryId, updateCategoryDto, getClientIp(req));
  }

  @Delete('events/:eventId/categories/:categoryId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete ticket category',
    description: 'Deletes a ticket category. Cannot delete if it has associated tickets.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'categoryId', description: 'Category UUID' })
  @ApiResponse({ status: 200, description: 'Ticket category deleted successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - category has associated tickets' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - Only organizer can delete categories',
  })
  @ApiResponse({ status: 404, description: 'Category not found' })
  removeCategory(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('categoryId') categoryId: string,
  ) {
    return this.ticketCategoriesService.remove(req.user.id, eventId, categoryId, getClientIp(req));
  }
}
