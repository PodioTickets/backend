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
import { CouponsService } from './coupons.service';
import { CreateCouponDto, UpdateCouponDto, FilterCouponsDto } from './dto/create-coupon.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NoCache } from 'src/common/decorators/cache.decorator';

@ApiTags('Coupons')
@Controller('api/v1/coupons')
export class CouponsController {
  constructor(private readonly couponsService: CouponsService) {}

  @Post('events/:eventId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create coupon',
    description: 'Creates a new coupon for an event. Only the event organizer can create coupons.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiBody({ type: CreateCouponDto })
  @ApiResponse({ status: 201, description: 'Coupon created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - validation error or code already exists' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can create coupons' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  create(@Request() req, @Param('eventId') eventId: string, @Body() createCouponDto: CreateCouponDto) {
    return this.couponsService.create(req.user.id, eventId, createCouponDto);
  }

  @Get('events/:eventId')
  @UseGuards(JwtAuthGuard)
  @NoCache()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List coupons',
    description: 'Retrieves all coupons for a specific event with pagination and optional status filter',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 10)' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ACTIVE', 'INACTIVE', 'EXPIRED'],
    description: 'Filter by coupon status',
  })
  @ApiResponse({ status: 200, description: 'Coupons retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  findAll(@Request() req, @Param('eventId') eventId: string, @Query() filterDto: FilterCouponsDto) {
    return this.couponsService.findAll(eventId, filterDto);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get coupon by ID',
    description: 'Retrieves a single coupon by its ID',
  })
  @ApiParam({ name: 'id', description: 'Coupon UUID' })
  @ApiResponse({ status: 200, description: 'Coupon retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Coupon not found' })
  findOne(@Param('id') id: string) {
    return this.couponsService.findOne(id);
  }

  @Patch('events/:eventId/:couponId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update coupon',
    description: 'Updates a coupon. Only the event organizer can update it. Cannot update coupons that have been used.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'couponId', description: 'Coupon UUID' })
  @ApiBody({ type: UpdateCouponDto })
  @ApiResponse({ status: 200, description: 'Coupon updated successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - validation error or coupon already used' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can update coupons' })
  @ApiResponse({ status: 404, description: 'Coupon not found' })
  update(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('couponId') couponId: string,
    @Body() updateCouponDto: UpdateCouponDto,
  ) {
    return this.couponsService.update(req.user.id, eventId, couponId, updateCouponDto);
  }

  @Delete('events/:eventId/:couponId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete coupon',
    description: 'Deletes a coupon. Only the event organizer can delete it. Cannot delete coupons that have been used.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'couponId', description: 'Coupon UUID' })
  @ApiResponse({ status: 200, description: 'Coupon deleted successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - coupon already used' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can delete coupons' })
  @ApiResponse({ status: 404, description: 'Coupon not found' })
  remove(@Request() req, @Param('eventId') eventId: string, @Param('couponId') couponId: string) {
    return this.couponsService.remove(req.user.id, eventId, couponId);
  }
}
