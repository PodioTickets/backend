import {
  Controller, Get, Post, Patch, Body, Param, Query, UseGuards,
  DefaultValuePipe, ParseIntPipe, UseInterceptors, UploadedFile,
  BadRequestException, Request,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ApiTags, ApiOperation, ApiBearerAuth,
  ApiQuery, ApiResponse, ApiParam, ApiBody, ApiConsumes,
} from '@nestjs/swagger';
import { IsEnum, IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';
import { WithdrawalStatus } from '@prisma/client';
import { AdminRepasseService } from './admin-repasse.service';
import { UploadService } from '../upload/upload.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { NoCache } from 'src/common/decorators/cache.decorator';

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

const RECEIPT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

@ApiTags('Admin — Repasses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/v1/admin')
export class AdminRepasseController {
  constructor(
    private readonly adminRepasseService: AdminRepasseService,
    private readonly uploadService: UploadService,
  ) { }

  @Get('withdrawals')
  @NoCache()
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
  @NoCache()
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
          pending: { count: 5, totalAmount: 50000, totalNetAmount: 48000 },
          completed: { count: 12, totalAmount: 120000, totalNetAmount: 115200 },
          cancelled: { count: 2, totalAmount: 20000, totalNetAmount: 19200 },
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

  @Get('withdrawals/:id')
  @NoCache()
  @ApiOperation({ summary: '[Admin] Detalhes de um repasse' })
  @ApiParam({ name: 'id', type: String, description: 'Withdrawal UUID' })
  @ApiResponse({ status: 200, description: 'Withdrawal detail' })
  @ApiResponse({ status: 404, description: 'Not found' })
  getWithdrawal(@Param('id') id: string) {
    return this.adminRepasseService.getWithdrawal(id);
  }

  @Patch('withdrawals/:id/receipt')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!RECEIPT_MIME_TYPES.includes(file.mimetype)) {
          return cb(new BadRequestException('Apenas arquivos PDF ou imagem são permitidos'), false);
        }
        cb(null, true);
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: '[Admin] Fazer upload do extrato/comprovante de um repasse' })
  @ApiParam({ name: 'id', type: String, description: 'Withdrawal UUID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'PDF ou imagem do extrato (máx 10 MB)' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Receipt uploaded and linked' })
  @ApiResponse({ status: 400, description: 'Invalid file' })
  @ApiResponse({ status: 404, description: 'Withdrawal not found' })
  async attachReceipt(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Arquivo é obrigatório');

    const isPdf = file.mimetype === 'application/pdf';
    const receiptUrl = isPdf
      ? await this.uploadService.uploadPdf(file)
      : await this.uploadService.compressImage(file);

    return this.adminRepasseService.attachWithdrawalReceipt(id, receiptUrl);
  }

  @Post('withdrawals/:id/approve')
  @ApiOperation({ summary: '[Admin] Aprovar um repasse pendente' })
  @ApiParam({ name: 'id', type: String, description: 'Withdrawal UUID' })
  @ApiResponse({ status: 200, description: 'Withdrawal approved' })
  @ApiResponse({ status: 400, description: 'Not in PENDING status' })
  @ApiResponse({ status: 404, description: 'Not found' })
  approveWithdrawal(@Param('id') id: string) {
    return this.adminRepasseService.approveWithdrawal(id);
  }

  @Post('withdrawals/:id/reject')
  @ApiOperation({ summary: '[Admin] Reprovar um repasse pendente' })
  @ApiParam({ name: 'id', type: String, description: 'Withdrawal UUID' })
  @ApiBody({ schema: { properties: { notes: { type: 'string', description: 'Motivo da reprovação' } } } })
  @ApiResponse({ status: 200, description: 'Withdrawal rejected' })
  @ApiResponse({ status: 400, description: 'Not in PENDING status' })
  @ApiResponse({ status: 404, description: 'Not found' })
  rejectWithdrawal(@Param('id') id: string, @Body('notes') notes?: string) {
    return this.adminRepasseService.rejectWithdrawal(id, notes);
  }

  // ─── Retenção de 10% ───────────────────────────────────────────────────────

  @Get('retention')
  @NoCache()
  @ApiOperation({
    summary: '[Admin] Listar eventos com retenção de 10% pendente de liberação',
    description:
      'Retorna todos os eventos que possuem valor retido (10%) ainda não liberado pelo admin. ' +
      'Inclui o valor total retido de cada evento calculado dinamicamente.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Filter by event name or organization' })
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'released'], description: 'Filter by retention status. Omit to return both.' })
  @ApiResponse({
    status: 200,
    description: 'Events with retention (pending + released) and monthly stats',
    schema: {
      example: {
        data: {
          stats: {
            pendingCount: 2,
            totalPendingVolume: 10000,
            totalProcessedThisMonth: 42000,
          },
          events: [
            {
              id: 'uuid',
              name: 'Event Name',
              slug: 'event-name',
              logoUrl: null,
              eventDate: '2026-03-01T00:00:00Z',
              retentionRate: 0.1,
              organization: { id: 'uuid', name: 'Org', email: 'org@email.com', logoUrl: null },
              status: 'pending',
              retainedAmount: 5000,
              grossRevenue: 100000,
              releasedAt: null,
              releasedBy: null,
              auditNotes: null,
            },
            {
              id: 'uuid2',
              name: 'Past Event',
              slug: 'past-event',
              logoUrl: null,
              eventDate: '2026-01-10T00:00:00Z',
              retentionRate: 0.1,
              organization: { id: 'uuid', name: 'Org', email: 'org@email.com', logoUrl: null },
              status: 'released',
              retainedAmount: 8000,
              grossRevenue: null,
              releasedAt: '2026-05-01T10:00:00Z',
              releasedBy: { id: 'uuid', firstName: 'Admin', lastName: 'User', email: 'admin@podio.com' },
              auditNotes: 'Reviewed and approved.',
            },
          ],
          pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
        },
      },
    },
  })
  getEventsWithRetention(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search') search?: string,
    @Query('status') status?: 'pending' | 'released',
  ) {
    return this.adminRepasseService.getEventsWithRetention(page, Math.min(limit, 100), search, status);
  }

  @Post('retention/:eventId/release')
  @ApiOperation({
    summary: '[Admin] Liberar retenção de 10% de um evento',
    description:
      'Libera o valor retido (10%) de um evento, movendo-o para saldo disponível do organizador. ' +
      'Após a liberação, nenhum valor futuro desse evento ficará em retenção.',
  })
  @ApiParam({ name: 'eventId', type: String, description: 'UUID do evento' })
  @ApiBody({
    schema: {
      properties: { notes: { type: 'string', description: 'Observações sobre a auditoria (opcional)' } },
    },
  })
  @ApiResponse({ status: 201, description: 'Retenção liberada com sucesso' })
  @ApiResponse({ status: 400, description: 'Retenção já foi liberada anteriormente' })
  @ApiResponse({ status: 404, description: 'Evento não encontrado' })
  releaseRetention(
    @Request() req,
    @Param('eventId') eventId: string,
    @Body('notes') notes?: string,
  ) {
    return this.adminRepasseService.releaseRetention(req.user.id, eventId, notes);
  }
}
