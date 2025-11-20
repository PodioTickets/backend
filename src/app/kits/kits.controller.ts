import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Request } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { KitsService } from './kits.service';
import { CreateKitDto, UpdateKitDto, CreateKitItemDto, UpdateKitItemDto } from './dto/create-kit.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('Kits')
@Controller('api/v1/kits')
export class KitsController {
  constructor(private readonly kitsService: KitsService) {}

  @Post('events/:eventId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create kit', description: 'Creates a new kit for an event. Only the event organizer can create kits.' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiBody({ type: CreateKitDto })
  @ApiResponse({ status: 201, description: 'Kit created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can create kits' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  create(@Request() req, @Param('eventId') eventId: string, @Body() createKitDto: CreateKitDto) {
    return this.kitsService.create(req.user.id, eventId, createKitDto);
  }

  @Get('events/:eventId')
  @ApiOperation({ summary: 'Get all kits for event', description: 'Retrieves all kits for a specific event' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiResponse({ status: 200, description: 'Kits retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  findAll(@Param('eventId') eventId: string) {
    return this.kitsService.findAll(eventId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get kit by ID', description: 'Retrieves a single kit by its ID' })
  @ApiParam({ name: 'id', description: 'Kit UUID' })
  @ApiResponse({ status: 200, description: 'Kit retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Kit not found' })
  findOne(@Param('id') id: string) {
    return this.kitsService.findOne(id);
  }

  @Patch('events/:eventId/:kitId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update kit', description: 'Updates a kit. Only the event organizer can update it.' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'kitId', description: 'Kit UUID' })
  @ApiBody({ type: UpdateKitDto })
  @ApiResponse({ status: 200, description: 'Kit updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can update kits' })
  @ApiResponse({ status: 404, description: 'Kit not found' })
  update(@Request() req, @Param('eventId') eventId: string, @Param('kitId') kitId: string, @Body() updateKitDto: UpdateKitDto) {
    return this.kitsService.update(req.user.id, eventId, kitId, updateKitDto);
  }

  @Delete('events/:eventId/:kitId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete kit', description: 'Deletes a kit. Only the event organizer can delete it.' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'kitId', description: 'Kit UUID' })
  @ApiResponse({ status: 200, description: 'Kit deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can delete kits' })
  @ApiResponse({ status: 404, description: 'Kit not found' })
  @ApiResponse({ status: 400, description: 'Bad request - Kit has active items' })
  remove(@Request() req, @Param('eventId') eventId: string, @Param('kitId') kitId: string) {
    return this.kitsService.remove(req.user.id, eventId, kitId);
  }

  // Kit Items
  @Post('events/:eventId/kits/:kitId/items')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create kit item', description: 'Creates a new item for a kit. Only the event organizer can create items.' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'kitId', description: 'Kit UUID' })
  @ApiBody({ type: CreateKitItemDto })
  @ApiResponse({ status: 201, description: 'Kit item created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can create items' })
  @ApiResponse({ status: 404, description: 'Kit not found' })
  createItem(@Request() req, @Param('eventId') eventId: string, @Param('kitId') kitId: string, @Body() createItemDto: CreateKitItemDto) {
    return this.kitsService.createItem(req.user.id, eventId, kitId, createItemDto);
  }

  @Patch('events/:eventId/kits/:kitId/items/:itemId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update kit item', description: 'Updates a kit item. Only the event organizer can update it.' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'kitId', description: 'Kit UUID' })
  @ApiParam({ name: 'itemId', description: 'Kit Item UUID' })
  @ApiBody({ type: UpdateKitItemDto })
  @ApiResponse({ status: 200, description: 'Kit item updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can update items' })
  @ApiResponse({ status: 404, description: 'Kit item not found' })
  updateItem(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('kitId') kitId: string,
    @Param('itemId') itemId: string,
    @Body() updateItemDto: UpdateKitItemDto,
  ) {
    return this.kitsService.updateItem(req.user.id, eventId, kitId, itemId, updateItemDto);
  }

  @Delete('events/:eventId/kits/:kitId/items/:itemId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete kit item', description: 'Deletes a kit item. Only the event organizer can delete it.' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'kitId', description: 'Kit UUID' })
  @ApiParam({ name: 'itemId', description: 'Kit Item UUID' })
  @ApiResponse({ status: 200, description: 'Kit item deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can delete items' })
  @ApiResponse({ status: 404, description: 'Kit item not found' })
  removeItem(@Request() req, @Param('eventId') eventId: string, @Param('kitId') kitId: string, @Param('itemId') itemId: string) {
    return this.kitsService.removeItem(req.user.id, eventId, kitId, itemId);
  }
}

