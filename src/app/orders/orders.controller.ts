import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NoCache } from '../../common/decorators/cache.decorator';
import { OrdersService } from './orders.service';
import { ReserveOrderDto } from './dto/reserve-order.dto';
import { PatchParticipantsDto } from './dto/patch-participants.dto';
import { PatchProductsDto } from './dto/patch-products.dto';
import { PatchBillingAddressDto } from './dto/patch-billing-address.dto';
import { PayOrderDto } from './dto/pay-order.dto';

@ApiTags('Orders')
@Controller('api/v1/orders')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) { }

  // ── POST /orders/reserve ───────────────────────────────────────────────

  @Post('reserve')
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: 'Reserve tickets',
    description:
      'Atomically reserves ticket stock and creates a PENDING order with a 30-minute expiry. ' +
      'If the user already has a PENDING order for the same event it is returned unchanged (idempotent).',
  })
  @ApiResponse({ status: 201, description: 'Order reserved successfully' })
  @ApiResponse({ status: 409, description: 'Batch sold out or too many pending orders' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async reserve(@Request() req: any, @Body() dto: ReserveOrderDto) {
    return this.ordersService.reserve(req.user.id, dto);
  }

  // ── GET /orders/:orderId ───────────────────────────────────────────────

  @Get(':orderId')
  @NoCache()
  @ApiOperation({ summary: 'Get order by ID' })
  @ApiParam({ name: 'orderId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Order details' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async findOrder(
    @Request() req: any,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.ordersService.findOrder(req.user.id, orderId);
  }

  // ── GET /orders/:orderId/details ──────────────────────────────────────────

  @Get(':orderId/details')
  @NoCache()
  @ApiOperation({
    summary: 'Get full order details',
    description:
      'Returns complete order data including event, payment info, billing address and all registrations with participant details, emergency contacts, tickets and question answers.',
  })
  @ApiParam({ name: 'orderId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Order details' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async getOrderDetails(
    @Request() req: any,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.ordersService.getOrderDetails(req.user.id, orderId);
  }

  // ── PATCH /orders/:orderId/participants ────────────────────────────────

  @Patch(':orderId/participants')
  @ApiOperation({ summary: 'Set participant data for the order' })
  @ApiParam({ name: 'orderId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Participants updated' })
  @ApiResponse({ status: 409, description: 'Order is no longer pending' })
  async patchParticipants(
    @Request() req: any,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: PatchParticipantsDto,
  ) {
    return this.ordersService.patchParticipants(req.user.id, orderId, dto);
  }

  // ── PATCH /orders/:orderId/products ────────────────────────────────────

  @Patch(':orderId/products')
  @ApiOperation({ summary: 'Set additional products for the order' })
  @ApiParam({ name: 'orderId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Products updated' })
  @ApiResponse({ status: 409, description: 'Order is no longer pending' })
  async patchProducts(
    @Request() req: any,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: PatchProductsDto,
  ) {
    return this.ordersService.patchProducts(req.user.id, orderId, dto);
  }

  // ── PATCH /orders/:orderId/billing-address ─────────────────────────────

  @Patch(':orderId/billing-address')
  @ApiOperation({ summary: 'Set billing address for the order' })
  @ApiParam({ name: 'orderId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Billing address updated' })
  @ApiResponse({ status: 409, description: 'Order is no longer pending' })
  async patchBillingAddress(
    @Request() req: any,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: PatchBillingAddressDto,
  ) {
    return this.ordersService.patchBillingAddress(req.user.id, orderId, dto);
  }

  // ── POST /orders/:orderId/pay ──────────────────────────────────────────

  @Post(':orderId/pay')
  @Throttle({ short: { limit: 3, ttl: 60000 } })
  @ApiOperation({
    summary: 'Pay for an order',
    description:
      'Processes payment for a PENDING order. ' +
      'Supports PIX (returns QR code) and CREDIT_CARD (creates registrations if approved). ' +
      'Pass an `Idempotency-Key` header to safely retry without double-charging.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'Unique key to ensure idempotent payment processing (recommended)',
    required: false,
  })
  @ApiParam({ name: 'orderId', type: String, format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Payment processed successfully' })
  @ApiResponse({ status: 402, description: 'Payment refused' })
  @ApiResponse({ status: 409, description: 'Order is no longer pending' })
  @ApiResponse({ status: 422, description: 'Missing billing address or participants' })
  async pay(
    @Request() req: any,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: PayOrderDto,
  ) {
    return this.ordersService.pay(req.user.id, orderId, idempotencyKey, dto);
  }

  // ── GET /orders/:orderId/payment-status ───────────────────────────────

  @Get(':orderId/payment-status')
  @NoCache()
  @ApiOperation({ summary: 'Get the current payment status of an order' })
  @ApiParam({ name: 'orderId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Payment status' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async getPaymentStatus(
    @Request() req: any,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.ordersService.getPaymentStatus(req.user.id, orderId);
  }
}
