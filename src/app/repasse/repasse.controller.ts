import {
  Controller, Get, Post, Patch, Param, Query, Body,
  UseGuards, Request, DefaultValuePipe, ParseIntPipe, ParseUUIDPipe,
} from '@nestjs/common';
import { RefundOrderDto } from '../payments/dto/refund-order.dto';
import { CancelOrderDto } from '../payments/dto/cancel-order.dto';
import {
  ApiTags, ApiOperation, ApiBearerAuth, ApiParam,
  ApiQuery, ApiResponse,
} from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { RepasseService } from './repasse.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

class RequestWithdrawalDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  amount: number; // centavos

  /**
   * Chave PIX da organização selecionada pelo organizador para receber o saque.
   * Obrigatório — o admin precisa do snapshot para executar o pagamento na
   * conta correta. Valida em runtime que pertence à org do evento.
   */
  @IsUUID()
  pixKeyId: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

class RequestAnticipationDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  amount: number; // centavos
}

class AuditEventDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

class CompleteWithdrawalDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

@ApiTags('Repasse')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/v1/events/:eventId/repasse')
export class RepasseController {
  constructor(private readonly repasseService: RepasseService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Resumo financeiro completo do repasse' })
  @ApiParam({ name: 'eventId', type: String })
  getSummary(@Request() req, @Param('eventId') eventId: string) {
    return this.repasseService.getSummary(req.user.id, eventId);
  }

  @Get('pending')
  @ApiOperation({ summary: 'Valores aguardando liberação (prazo + retenção 10%)' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getPending(
    @Request() req,
    @Param('eventId') eventId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.repasseService.getPendingReleases(req.user.id, eventId, page, Math.min(limit, 100));
  }

  @Get('installments')
  @ApiOperation({ summary: 'Parcelas a receber (cartão parcelado)' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getInstallments(
    @Request() req,
    @Param('eventId') eventId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.repasseService.getInstallments(req.user.id, eventId, page, Math.min(limit, 100));
  }

  @Get('withdrawals')
  @ApiOperation({ summary: 'Histórico de repasses (saques)' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getWithdrawals(
    @Request() req,
    @Param('eventId') eventId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.repasseService.getWithdrawals(req.user.id, eventId, page, Math.min(limit, 100));
  }

  @Post('withdrawals')
  @ApiOperation({ summary: 'Solicitar repasse (saque)' })
  @ApiParam({ name: 'eventId', type: String })
  requestWithdrawal(
    @Request() req,
    @Param('eventId') eventId: string,
    @Body() dto: RequestWithdrawalDto,
  ) {
    return this.repasseService.requestWithdrawal(req.user.id, eventId, dto.amount, dto.pixKeyId);
  }

  @Patch('withdrawals/:withdrawalId/complete')
  @ApiOperation({ summary: '[Admin] Marcar repasse como concluído' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'withdrawalId', type: String })
  completeWithdrawal(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('withdrawalId') withdrawalId: string,
  ) {
    return this.repasseService.completeWithdrawal(req.user.id, eventId, withdrawalId);
  }

  @Patch('withdrawals/:withdrawalId/cancel')
  @ApiOperation({ summary: '[Admin] Cancelar repasse' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'withdrawalId', type: String })
  cancelWithdrawal(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('withdrawalId') withdrawalId: string,
  ) {
    return this.repasseService.cancelWithdrawal(req.user.id, eventId, withdrawalId);
  }

  // ─── Antecipação de recebíveis ──────────────────────────────────────────

  @Get('anticipations/quote')
  @ApiOperation({ summary: 'Cotação de antecipação (disponível + taxa + pedidos)' })
  @ApiParam({ name: 'eventId', type: String })
  getAnticipationQuote(@Request() req, @Param('eventId') eventId: string) {
    return this.repasseService.getAnticipationQuote(req.user.id, eventId);
  }

  @Get('anticipations')
  @ApiOperation({ summary: 'Histórico de antecipações' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getAnticipations(
    @Request() req,
    @Param('eventId') eventId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.repasseService.getAnticipations(req.user.id, eventId, page, Math.min(limit, 100));
  }

  @Post('anticipations')
  @ApiOperation({ summary: 'Solicitar antecipação de recebíveis' })
  @ApiParam({ name: 'eventId', type: String })
  requestAnticipation(
    @Request() req,
    @Param('eventId') eventId: string,
    @Body() dto: RequestAnticipationDto,
  ) {
    return this.repasseService.requestAnticipation(req.user.id, eventId, dto.amount);
  }

  @Patch('anticipations/:anticipationId/complete')
  @ApiOperation({ summary: '[Admin] Marcar antecipação como concluída' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'anticipationId', type: String })
  completeAnticipation(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('anticipationId') anticipationId: string,
  ) {
    return this.repasseService.completeAnticipation(req.user.id, eventId, anticipationId);
  }

  @Patch('anticipations/:anticipationId/cancel')
  @ApiOperation({ summary: '[Admin] Cancelar antecipação' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'anticipationId', type: String })
  cancelAnticipation(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('anticipationId') anticipationId: string,
  ) {
    return this.repasseService.cancelAnticipation(req.user.id, eventId, anticipationId);
  }

  @Get('refunded')
  @ApiOperation({ summary: 'Pedidos estornados' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getRefunded(
    @Request() req,
    @Param('eventId') eventId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.repasseService.getRefunded(req.user.id, eventId, page, Math.min(limit, 100));
  }

  @Post('orders/:orderId/refund')
  @ApiOperation({
    summary: 'Estornar pedido (organizador c/ permissão financeira)',
    description:
      'Estorno TOTAL e imediato de um pedido pago do evento. Requer permissão `financial` sobre o ' +
      'evento (não é admin). Reusa o MESMO engine do estorno admin: void na Cielo, marca REFUNDED, ' +
      'cancela pedido + inscrições, reverte cupom/voucher e cobra a taxa de refund (2%). O pedido ' +
      'precisa pertencer a este evento. Saldo pode ficar negativo (esperado). Só total e na hora.',
  })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'orderId', type: String, description: 'UUID do pedido a estornar' })
  @ApiResponse({ status: 201, description: 'Estorno realizado com sucesso' })
  @ApiResponse({ status: 403, description: 'Sem permissão financeira sobre o evento' })
  @ApiResponse({ status: 404, description: 'Pedido não encontrado neste evento' })
  @ApiResponse({ status: 409, description: 'Pedido não está PAID ou já estornado' })
  @ApiResponse({ status: 422, description: 'Método de pagamento não suporta estorno via API' })
  refundOrder(
    @Request() req,
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: RefundOrderDto,
  ) {
    return this.repasseService.refundOrder(req.user.id, eventId, orderId, dto, req.ip);
  }

  @Post('orders/:orderId/cancel')
  @ApiOperation({
    summary: 'Cancelar pedido GRATUITO (organizador c/ permissão financeira)',
    description:
      'Cancela um pedido SEM valor pago (free order, finalAmount 0). Não chama a Cielo nem ' +
      'cobra taxa — marca o pedido CANCELLED, cancela as inscrições, reverte cupom/voucher e ' +
      'grava audit log. Requer permissão `financial` sobre o evento. Pedido com valor pago é ' +
      'rejeitado (409 ORDER_HAS_PAYMENT) — esse caso é estorno.',
  })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'orderId', type: String, description: 'UUID do pedido a cancelar' })
  @ApiResponse({ status: 201, description: 'Pedido cancelado com sucesso' })
  @ApiResponse({ status: 403, description: 'Sem permissão financeira sobre o evento' })
  @ApiResponse({ status: 404, description: 'Pedido não encontrado neste evento' })
  @ApiResponse({ status: 409, description: 'Pedido possui valor pago, já cancelado ou não cancelável' })
  cancelOrder(
    @Request() req,
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: CancelOrderDto,
  ) {
    return this.repasseService.cancelFreeOrder(req.user.id, eventId, orderId, dto, req.ip);
  }

  @Get('audit')
  @ApiOperation({ summary: 'Status da auditoria do evento' })
  @ApiParam({ name: 'eventId', type: String })
  getAudit(@Request() req, @Param('eventId') eventId: string) {
    return this.repasseService.getAuditStatus(req.user.id, eventId);
  }

  @Post('audit')
  @ApiOperation({ summary: '[Admin] Realizar auditoria — libera os 10% retidos' })
  @ApiParam({ name: 'eventId', type: String })
  auditEvent(
    @Request() req,
    @Param('eventId') eventId: string,
    @Body() dto: AuditEventDto,
  ) {
    return this.repasseService.auditEvent(req.user.id, eventId, dto.notes);
  }
}
