import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseIntPipe,
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
import { CreateCourtesyOrderDto } from './dto/create-courtesy-order.dto';
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
// Telemetria de funil: o interceptor é registrado no controller inteiro, mas só grava nas
// rotas marcadas com @TrackActivity (pass-through custo-zero nas demais). Cada ETAPA do
// checkout é contabilizada — inclusive falhas (trackErrors default), pra medir drop-off.
// Fora do funil de propósito: GET :orderId/details (leitura) e payment-status (polling PIX).
@UseInterceptors(TrackActivityInterceptor)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) { }

  // ── POST /orders/reserve ───────────────────────────────────────────────

  @Post('reserve')
  @Throttle({ short: { limit: 5, ttl: 60000 } })
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

  // ── POST /orders/courtesy ──────────────────────────────────────────────

  @Post('courtesy')
  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Create a courtesy registration (organizer)',
    description:
      'Cria uma inscrição de CORTESIA (R$0, sem pagamento) para o evento — replica ' +
      'o checkout (ingressos → participantes → produtos), sem preço nem etapa de ' +
      'pagamento, e finaliza o pedido como PAID. Requer admin OU permissão ' +
      'edit_event na organização do evento. Envia o ingresso por e-mail.',
  })
  @ApiResponse({ status: 201, description: 'Courtesy registration created' })
  @ApiResponse({ status: 403, description: 'Missing permission' })
  @ApiResponse({ status: 409, description: 'Batch/event sold out' })
  async createCourtesy(
    @Request() req: any,
    @Body() dto: CreateCourtesyOrderDto,
  ) {
    return this.ordersService.createCourtesyRegistration(req.user.id, dto);
  }

  // ── POST /orders/:orderId/courtesy-finalize ────────────────────────────

  @Post(':orderId/courtesy-finalize')
  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Finalize a reserved order as courtesy (organizer)',
    description:
      'Finaliza como CORTESIA (R$0) um pedido já RESERVADO pelo organizador — o ' +
      'fluxo reaproveita reserve → participants → products do checkout e troca o ' +
      'pagamento por esta chamada. Requer admin OU edit_event e ser dono do pedido.',
  })
  @ApiParam({ name: 'orderId', description: 'Order ID' })
  @ApiResponse({ status: 201, description: 'Courtesy registration finalized' })
  @ApiResponse({ status: 403, description: 'Missing permission' })
  async finalizeCourtesy(
    @Request() req: any,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.ordersService.finalizeCourtesy(req.user.id, orderId);
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
  @TrackActivity({ category: 'CHECKOUT', action: 'order.participants' })
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

  // ── DELETE /orders/:orderId/participants/:slot ─────────────────────────
  // Remove UM ingresso/slot do pedido (reduz a quantidade reservada em 1): libera estoque,
  // cancela 1 placeholder, apara o participante daquele slot e recalcula cupom — SEM recriar
  // o pedido. `slot` = índice (0-based) do participante/unidade reservada.
  @Delete(':orderId/participants/:slot')
  @TrackActivity({ category: 'CHECKOUT', action: 'order.participants.remove' })
  @ApiOperation({ summary: 'Remove a reserved ticket/participant slot (reduz a quantidade em 1)' })
  @ApiParam({ name: 'orderId', type: String, format: 'uuid' })
  @ApiParam({ name: 'slot', type: Number, description: 'Índice (0-based) do slot a remover' })
  @ApiResponse({ status: 200, description: 'Slot removido' })
  @ApiResponse({ status: 409, description: 'Pedido não está mais pendente' })
  @ApiResponse({ status: 422, description: 'Índice inválido ou último ingresso (cancele o pedido)' })
  async removeReservedSlot(
    @Request() req: any,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('slot', ParseIntPipe) slot: number,
  ) {
    return this.ordersService.removeReservedSlot(req.user.id, orderId, slot);
  }

  // ── PATCH /orders/:orderId/products ────────────────────────────────────

  @Patch(':orderId/products')
  @TrackActivity({ category: 'CHECKOUT', action: 'order.products' })
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
  @TrackActivity({ category: 'CHECKOUT', action: 'order.billing-address' })
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
  @TrackActivity({ category: 'CHECKOUT', action: 'order.coupon' })
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
  // Conta como etapa do funil: sinaliza que o usuário entrou no fluxo de débito 3DS
  // (1 chamada por tentativa de pagamento — baixo volume, alto valor de análise).
  @TrackActivity({ category: 'CHECKOUT', action: 'order.3ds-token' })
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
