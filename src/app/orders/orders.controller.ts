import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  UseGuards,
  UseInterceptors,
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
import { PatchCouponDto } from './dto/patch-coupon.dto';
import { TrackActivity } from '../../common/decorators/track-activity.decorator';
import { TrackActivityInterceptor } from '../../common/interceptors/track-activity.interceptor';

@ApiTags('Orders')
@Controller('api/v1/orders')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) { }

  // ── POST /orders/reserve ───────────────────────────────────────────────

  @Post('reserve')
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @UseInterceptors(TrackActivityInterceptor)
  @TrackActivity({ category: 'CHECKOUT', action: 'order.reserve' })
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

  // ── PATCH /orders/:orderId/coupon ─────────────────────────────────────

  @Patch(':orderId/coupon')
  @ApiOperation({
    summary: 'Apply or remove coupon/voucher',
    description: 'Apply a DISCOUNT coupon or voucher to the order. Send empty body to remove. Automatic coupons (QUANTITY/AGE) are applied automatically on PATCH /products.',
  })
  @ApiParam({ name: 'orderId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Coupon/voucher applied' })
  @ApiResponse({ status: 409, description: 'Order is no longer pending' })
  @ApiResponse({ status: 422, description: 'Invalid coupon or voucher' })
  async patchCoupon(
    @Request() req: any,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: PatchCouponDto,
  ) {
    return this.ordersService.patchCoupon(req.user.id, orderId, dto);
  }

  // ── POST /orders/:orderId/pay ──────────────────────────────────────────

  @Post(':orderId/pay')
  @Throttle({ short: { limit: 3, ttl: 60000 } })
  @UseInterceptors(TrackActivityInterceptor)
  @TrackActivity({ category: 'CHECKOUT', action: 'order.pay' })
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

  // ── POST /orders/:orderId/force-expire (dev only) ─────────────────────

  @Post(':orderId/force-expire')
  @NoCache()
  @ApiOperation({ summary: '[DEV] Force order expiry for testing — unavailable in production' })
  @ApiParam({ name: 'orderId', type: String, format: 'uuid' })
  async forceExpire(
    @Request() req: any,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('Not available in production');
    }
    return this.ordersService.forceExpire(req.user.id, orderId);
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

  // ── GET /orders/:orderId/3ds-token ────────────────────────────────────

  @Get(':orderId/3ds-token')
  @NoCache()
  @ApiOperation({
    summary: 'Obter access token 3DS para autenticação do cartão de débito',
    description:
      'Retorna um JWT do Braspag/Cielo para inicializar o SDK 3DS no frontend. ' +
      'O pedido deve estar PENDING. O token tem validade de ~1h e é cacheado no servidor.',
  })
  @ApiParam({ name: 'orderId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Access token 3DS', schema: { properties: { accessToken: { type: 'string' } } } })
  @ApiResponse({ status: 400, description: 'Pedido não está PENDING ou credenciais 3DS não configuradas' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async get3dsToken(
    @Request() req: any,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.ordersService.get3dsToken(req.user.id, orderId);
  }
}
