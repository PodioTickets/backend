import {
  Controller, Get, Post, Patch, Param, Query, Body,
  UseGuards, Request, DefaultValuePipe, ParseIntPipe,
} from '@nestjs/common';
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
