import { Controller, Get, Post, Body, Patch, Param, Delete, Query, UseGuards, Request } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { VouchersService } from './vouchers.service';
import { CreateVoucherDto, UpdateVoucherDto, FilterVouchersDto } from './dto/create-voucher.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NoCache } from 'src/common/decorators/cache.decorator';

@ApiTags('Vouchers')
@Controller('api/v1/vouchers')
export class VouchersController {
  constructor(private readonly vouchersService: VouchersService) {}

  @Post('events/:eventId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create vouchers',
    description: 'Creates a batch of vouchers for an event. Each voucher will have a unique code generated automatically.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiBody({ type: CreateVoucherDto })
  @ApiResponse({ status: 201, description: 'Vouchers created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - validation error' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can create vouchers' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  create(@Request() req, @Param('eventId') eventId: string, @Body() createVoucherDto: CreateVoucherDto) {
    return this.vouchersService.create(req.user.id, eventId, createVoucherDto);
  }

  @Get('events/:eventId')
  @UseGuards(JwtAuthGuard)
  @NoCache()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List voucher groups',
    description: 'Retrieves voucher groups (grouped by name) for a specific event with pagination and optional status filter. Each group shows aggregated statistics.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20)' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ACTIVE', 'USED', 'EXPIRED', 'INACTIVE'],
    description: 'Filter by voucher status (applies to individual vouchers within groups)',
  })
  @ApiResponse({ status: 200, description: 'Voucher groups retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  findAll(@Request() req, @Param('eventId') eventId: string, @Query() filterDto: FilterVouchersDto) {
    return this.vouchersService.findAll(eventId, filterDto);
  }

  @Get('events/:eventId/groups/:groupName')
  @UseGuards(JwtAuthGuard)
  @NoCache()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get vouchers by group name',
    description: 'Retrieves all individual vouchers from a specific group (by name) with pagination and optional status filter',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'groupName', description: 'Voucher group name (e.g., "Voucher100")' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20)' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ACTIVE', 'USED', 'EXPIRED', 'INACTIVE'],
    description: 'Filter by voucher status',
  })
  @ApiResponse({ status: 200, description: 'Group vouchers retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Event or group not found' })
  findGroupVouchers(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('groupName') groupName: string,
    @Query() filterDto: FilterVouchersDto,
  ) {
    return this.vouchersService.findGroupVouchers(eventId, groupName, filterDto);
  }

  @Get('code/:code')
  @ApiOperation({
    summary: 'Get voucher by code',
    description: 'Retrieves a single voucher by its code',
  })
  @ApiParam({ name: 'code', description: 'Voucher code' })
  @ApiResponse({ status: 200, description: 'Voucher retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Voucher not found' })
  findByCode(@Param('code') code: string) {
    return this.vouchersService.findByCode(code);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get voucher by ID',
    description: 'Retrieves a single voucher by its ID',
  })
  @ApiParam({ name: 'id', description: 'Voucher UUID' })
  @ApiResponse({ status: 200, description: 'Voucher retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Voucher not found' })
  findOne(@Param('id') id: string) {
    return this.vouchersService.findOne(id);
  }

  @Patch('events/:eventId/:voucherId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update voucher',
    description: 'Updates a voucher. Only the event organizer can update it. Cannot update vouchers that have been used.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'voucherId', description: 'Voucher UUID' })
  @ApiBody({ type: UpdateVoucherDto })
  @ApiResponse({ status: 200, description: 'Voucher updated successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - validation error or voucher already used' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can update vouchers' })
  @ApiResponse({ status: 404, description: 'Voucher not found' })
  update(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('voucherId') voucherId: string,
    @Body() updateVoucherDto: UpdateVoucherDto,
  ) {
    return this.vouchersService.update(req.user.id, eventId, voucherId, updateVoucherDto);
  }

  @Delete('events/:eventId/:voucherId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete voucher',
    description: 'Deletes a voucher. Only the event organizer can delete it. Cannot delete vouchers that have been used.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'voucherId', description: 'Voucher UUID' })
  @ApiResponse({ status: 200, description: 'Voucher deleted successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - voucher already used' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can delete vouchers' })
  @ApiResponse({ status: 404, description: 'Voucher not found' })
  remove(@Request() req, @Param('eventId') eventId: string, @Param('voucherId') voucherId: string) {
    return this.vouchersService.remove(req.user.id, eventId, voucherId);
  }
}
