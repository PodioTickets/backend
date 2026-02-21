import { Controller, Post, Body, UseGuards, Request } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { CheckoutService } from './checkout.service';
import { ProcessCheckoutDto } from './dto/process-checkout.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('Checkout')
@Controller('api/v1/checkout')
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Post('process')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Process checkout',
    description:
      'Processa uma compra completa incluindo validação de cupons/vouchers, cálculo de preços, processamento de pagamento e criação de inscrições',
  })
  @ApiBody({ type: ProcessCheckoutDto })
  @ApiResponse({
    status: 200,
    description: 'Checkout processado com sucesso',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        registrations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
            },
          },
        },
        payment: {
          type: 'object',
          properties: {
            method: { type: 'string' },
            status: { type: 'string' },
            transactionId: { type: 'string' },
            pix: { type: 'object' },
            boleto: { type: 'object' },
            creditCard: { type: 'object' },
          },
        },
        total: { type: 'number' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Bad request - Dados inválidos' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Evento ou ingresso não encontrado' })
  async processCheckout(@Request() req, @Body() dto: ProcessCheckoutDto) {
    return this.checkoutService.processCheckout(req.user.id, dto);
  }
}
