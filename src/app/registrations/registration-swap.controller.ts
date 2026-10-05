import { Body, Controller, Param, ParseUUIDPipe, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { TrackActivity } from '../../common/decorators/track-activity.decorator';
import { TrackActivityInterceptor } from '../../common/interceptors/track-activity.interceptor';
import { RegistrationSwapService } from './registration-swap.service';
import { SwapRegistrationTicketDto } from './dto/swap-registration-ticket.dto';

@ApiTags('Admin — Registrations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/v1/admin/registrations')
export class RegistrationSwapController {
  constructor(private readonly swapService: RegistrationSwapService) {}

  @Post(':id/swap-ticket')
  @UseInterceptors(TrackActivityInterceptor)
  @TrackActivity({ category: 'COMPLIANCE', action: 'registration.swap_ticket' })
  @ApiOperation({
    summary: '[Admin] Trocar o ingresso de uma inscrição',
    description:
      'Anula a inscrição (status CANCELLED + voidedAt) e cria uma nova no mesmo pedido com o ' +
      'ingresso escolhido. Sem cobrança/estorno. Move o estoque (lote e produtos) e envia o ' +
      'ingresso novo ao e-mail do participante.',
  })
  @ApiParam({ name: 'id', type: String, description: 'UUID da inscrição a trocar' })
  @ApiResponse({ status: 201, description: '{ registrationId (nova), emailSent }' })
  @ApiResponse({ status: 409, description: 'Lote esgotado ou inscrição já trocada' })
  @ApiResponse({ status: 422, description: 'Participante fora das regras do ingresso ou produto inválido/esgotado' })
  swapTicket(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SwapRegistrationTicketDto,
    @Req() req: any,
  ) {
    return this.swapService.swapTicket({
      registrationId: id,
      ticketId: dto.ticketId,
      products: dto.products ?? [],
      adminUserId: req.user.id,
      ip: req.ip,
    });
  }
}
