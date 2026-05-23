import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';
import { UserActivitySource } from '@prisma/client';

import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { UserActivityService } from '../../common/services/user-activity.service';
import { getClientIp } from '../../common/utils/client-ip.util';
import { RecordActivityBatchDto } from './dto/record-activity.dto';

/**
 * Ingestão de eventos de telemetria do frontend.
 *
 * Características:
 *  - Anônimo-friendly: usa OptionalJwtAuthGuard. Se vier JWT válido,
 *    associa `userId`; sem JWT, vai como anônimo (só `sessionId`).
 *  - Fire-and-forget: enfileira e responde 202 sem await. Latência típica
 *    < 1ms.
 *  - Sem rate-limit dedicado: o ThrottlerGuard global (10/s, 50/10s,
 *    200/min) + buffer cap do service são suficientes pra absorver
 *    spikes legítimos e dropar abuso.
 */
@ApiTags('User Activity')
@Controller('api/v1/me/activity')
export class UserActivityController {
  constructor(private readonly activity: UserActivityService) {}

  @Post('events')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Ingest user activity batch (front telemetry)',
    description:
      'Recebe um batch de eventos UX (cliques, page-views, scrolls, etc.) e enfileira pra gravação em batch. Aceita anônimo (sem JWT) — nesse caso `sessionId` é obrigatório pro front costurar a jornada antes do login. Chaves PII no `metadata` são removidas no backend (defesa em profundidade).',
  })
  @ApiBody({ type: RecordActivityBatchDto })
  @ApiResponse({
    status: 202,
    description: 'Aceito e enfileirado (não há garantia de persistência imediata).',
  })
  @ApiResponse({ status: 400, description: 'Batch inválido.' })
  async recordBatch(
    @Request() req: ExpressRequest & { user?: { id?: string } },
    @Body() body: RecordActivityBatchDto,
  ): Promise<{ accepted: number }> {
    const userId = req.user?.id ?? null;
    const sessionId = body.sessionId ?? null;
    const ip = getClientIp(req) || null;
    const userAgent =
      (req.headers['user-agent'] as string | undefined) ?? null;
    const referrer =
      (req.headers['referer'] as string | undefined) ??
      (req.headers['referrer'] as string | undefined) ??
      null;

    // Loop simples — record() é síncrono (push em array). N = até 50, então
    // 50 pushes ≈ < 1ms total.
    for (const event of body.events) {
      this.activity.record({
        userId,
        sessionId,
        ip,
        userAgent,
        source: UserActivitySource.FRONTEND,
        category: event.category,
        action: event.action,
        path: event.path ?? null,
        referrer: event.referrer ?? referrer,
        metadata: event.metadata ?? null,
      });
    }

    return { accepted: body.events.length };
  }
}
