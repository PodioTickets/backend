import {
  Controller, Get, Query, UseGuards,
  DefaultValuePipe, ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags, ApiOperation, ApiBearerAuth,
  ApiQuery, ApiResponse,
} from '@nestjs/swagger';
import { IsEnum, IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';
import { WithdrawalStatus } from '@prisma/client';
import { AdminRepasseService } from './admin-repasse.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

class WithdrawalsQueryDto {
  @IsOptional()
  @IsNumberString()
  page?: string;

  @IsOptional()
  @IsNumberString()
  limit?: string;

  @IsOptional()
  @IsEnum(WithdrawalStatus)
  status?: WithdrawalStatus;

  @IsOptional()
  @IsUUID()
  eventId?: string;

  @IsOptional()
  @IsString()
  search?: string;
}

@ApiTags('Admin — Repasses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/v1/admin')
export class AdminRepasseController {
  constructor(private readonly adminRepasseService: AdminRepasseService) {}

  @Get('withdrawals')
  @ApiOperation({ summary: '[Admin] Listagem global de repasses' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'status', required: false, enum: WithdrawalStatus })
  @ApiQuery({ name: 'eventId', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Busca por nome do evento, nome ou email do organizador' })
  @ApiResponse({ status: 200, description: 'Lista de repasses com paginação' })
  getWithdrawals(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query() query: WithdrawalsQueryDto,
  ) {
    return this.adminRepasseService.getWithdrawals({
      page,
      limit: Math.min(limit, 100),
      status: query.status,
      eventId: query.eventId,
      search: query.search,
    });
  }

  @Get('withdrawals/stats')
  @ApiOperation({
    summary: '[Admin] Estatísticas globais de repasses',
    description: 'Retorna totais por status (pendente, concluído, cancelado) e dados sobre taxas arrecadadas.',
  })
  @ApiResponse({
    status: 200,
    description: 'Stats globais',
    schema: {
      example: {
        data: {
          pending:   { count: 5,  totalAmount: 50000,  totalNetAmount: 48000  },
          completed: { count: 12, totalAmount: 120000, totalNetAmount: 115200 },
          cancelled: { count: 2,  totalAmount: 20000,  totalNetAmount: 19200  },
          fees: {
            totalCollected: 4800,
            avgFeeRate: 0.04,
            effectiveFeePercent: 4.0,
          },
          overview: {
            totalEventsWithWithdrawals: 8,
            totalWithdrawals: 19,
            totalGrossRequested: 190000,
          },
        },
      },
    },
  })
  getStats() {
    return this.adminRepasseService.getStats();
  }
}
