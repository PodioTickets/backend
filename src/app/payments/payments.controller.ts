import { Controller, Get, Post, Body, Param, UseGuards, Request, Headers, RawBodyRequest, Req } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
  ApiHeader,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto, ProcessPaymentDto, ConfirmPaymentDto } from './dto/create-payment.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CieloService } from './cielo.service';
import { PaymentsWebhookService } from './payments-webhook.service';

@ApiTags('Payments')
@Controller('api/v1/payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly cieloService: CieloService,
    private readonly webhookService: PaymentsWebhookService,
  ) { }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create payment', description: 'Creates a new payment intent for a registration' })
  @ApiBody({ type: CreatePaymentDto })
  @ApiResponse({ status: 201, description: 'Payment created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - Invalid payment data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Registration not found' })
  create(@Request() req, @Body() createPaymentDto: CreatePaymentDto) {
    return this.paymentsService.create(req.user.id, createPaymentDto);
  }

  @Post('confirm')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm payment', description: 'Confirms a payment after processing' })
  @ApiBody({ type: ConfirmPaymentDto })
  @ApiResponse({ status: 200, description: 'Payment confirmed successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - Invalid confirmation data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  confirmPayment(@Request() req, @Body() confirmPaymentDto: ConfirmPaymentDto) {
    return this.paymentsService.confirmPayment(req.user.id, confirmPaymentDto);
  }

  @Post('process')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Process payment', description: 'Processes a payment using the selected payment method (PIX, Card, Boleto, Crypto)' })
  @ApiBody({ type: ProcessPaymentDto })
  @ApiResponse({ status: 200, description: 'Payment processed successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - Invalid payment data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  processPayment(@Request() req, @Body() processPaymentDto: ProcessPaymentDto) {
    return this.paymentsService.processPayment(req.user.id, processPaymentDto);
  }

  @Post('webhook')
  @Throttle({ short: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'Cielo webhook endpoint', description: 'Receives webhook events from Cielo for payment status updates' })
  @ApiHeader({ name: 'cielo-signature', description: 'Cielo webhook signature' })
  @ApiResponse({ status: 200, description: 'Webhook received successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - Invalid signature or payload' })
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('cielo-signature') signature: string,
    @Body() body: any,
  ) {
    const payload = req.rawBody?.toString() || JSON.stringify(body);
    if (!payload || !signature) return { received: false };
    const event = await this.cieloService.handleWebhook(signature, payload);
    if (!event) return { received: false, error: 'Invalid signature' };
    await this.webhookService.handleWebhook(event);
    return { received: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my payments', description: 'Retrieves all payments for the authenticated user' })
  @ApiResponse({ status: 200, description: 'Payments retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getUserPayments(@Request() req) {
    return this.paymentsService.getUserPayments(req.user.id);
  }

  @Get('registration/:registrationId/summary')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get payment summary', description: 'Retrieves payment summary for a registration' })
  @ApiParam({ name: 'registrationId', description: 'Registration UUID' })
  @ApiResponse({ status: 200, description: 'Payment summary retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Registration not found' })
  getPaymentSummary(@Param('registrationId') registrationId: string) {
    return this.paymentsService.getPaymentSummary(registrationId);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get payment by ID', description: 'Retrieves a single payment by ID. Only the payment owner can access it.' })
  @ApiParam({ name: 'id', description: 'Payment UUID' })
  @ApiResponse({ status: 200, description: 'Payment retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only payment owner can access' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  findOne(@Request() req, @Param('id') id: string) {
    return this.paymentsService.findOne(id, req.user.id);
  }

  @Get('transaction/:transactionId/details')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get payment details by transaction ID',
    description: 'Retrieves complete payment details including buyer, payment, event, and organizer information. Accessible by payment owner or event organizer.',
  })
  @ApiParam({ name: 'transactionId', description: 'Transaction ID from payment gateway' })
  @ApiResponse({ status: 200, description: 'Payment details retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Access denied' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  getPaymentDetailsByTransaction(@Request() req, @Param('transactionId') transactionId: string) {
    return this.paymentsService.getPaymentDetails(transactionId, 'transaction', req.user.id);
  }

  @Get('order/:orderId/details')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get payment details by order ID',
    description: 'Retrieves complete payment details including buyer, payment, event, and organizer information. Accessible by payment owner or event organizer.',
  })
  @ApiParam({ name: 'orderId', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Payment details retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Access denied' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  getPaymentDetailsByOrder(@Request() req, @Param('orderId') orderId: string) {
    return this.paymentsService.getPaymentDetails(orderId, 'order', req.user.id);
  }

  @Get('payment/:paymentId/details')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get payment details by payment ID',
    description: 'Retrieves complete payment details including buyer, payment, event, and organizer information. Accessible by payment owner or event organizer.',
  })
  @ApiParam({ name: 'paymentId', description: 'Payment UUID' })
  @ApiResponse({ status: 200, description: 'Payment details retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Access denied' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  getPaymentDetailsByPaymentId(@Request() req, @Param('paymentId') paymentId: string) {
    return this.paymentsService.getPaymentDetails(paymentId, 'payment', req.user.id);
  }
}

