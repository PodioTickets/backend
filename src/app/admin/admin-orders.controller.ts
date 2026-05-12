import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { PaymentsRefundService } from '../payments/payments-refund.service';
import { RefundOrderDto } from '../payments/dto/refund-order.dto';

@ApiTags('Admin — Orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/v1/admin/orders')
export class AdminOrdersController {
  constructor(private readonly refundService: PaymentsRefundService) {}

  @Post(':id/refund')
  @ApiOperation({
    summary: '[Admin] Estornar pedido pago via Cielo',
    description:
      'Inicia um estorno total na Cielo (PUT /v2/sales/{paymentId}/void) e propaga os ' +
      'efeitos para o sistema: marca pagamento como REFUNDED (refundType=REFUND), ' +
      'cancela o pedido, cancela inscrições associadas, decrementa uso do cupom e ' +
      'libera o voucher para reuso. Audit log em OrganizationAuditLog.\n\n' +
      'Métodos suportados: PIX, CREDIT_CARD, DEBIT_CARD. BOLETO e CRYPTO retornam 422.\n\n' +
      'Por padrão, retorna 409 se o saldo do organizador no evento não cobrir o valor ' +
      'do estorno — passe `force: true` para sobrescrever (uso típico: chargeback ' +
      'inevitável, mesmo com saldo organizador insuficiente).',
  })
  @ApiParam({ name: 'id', type: String, description: 'UUID do pedido a estornar' })
  @ApiBody({ type: RefundOrderDto })
  @ApiResponse({ status: 201, description: 'Estorno realizado com sucesso' })
  @ApiResponse({ status: 400, description: 'Cielo recusou a operação' })
  @ApiResponse({ status: 404, description: 'Pedido não encontrado' })
  @ApiResponse({
    status: 409,
    description:
      'Pedido não está PAID, pagamento já estornado, ou saldo do organizador insuficiente (use force=true)',
  })
  @ApiResponse({ status: 422, description: 'Método de pagamento não suporta estorno via API' })
  refundOrder(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RefundOrderDto,
    @Req() req: any,
  ) {
    return this.refundService.refundOrder({
      orderId: id,
      adminUserId: req.user.id,
      reason: dto.reason,
      force: dto.force ?? false,
      ip: req.ip,
    });
  }
}
