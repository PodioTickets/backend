import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request as ExpressRequest } from 'express';
import { Observable, tap, catchError, throwError } from 'rxjs';
import { UserActivitySource } from '@prisma/client';
import {
  TRACK_ACTIVITY_KEY,
  TrackActivityOptions,
} from '../decorators/track-activity.decorator';
import { UserActivityService } from '../services/user-activity.service';
import { getClientIp } from '../utils/client-ip.util';

/**
 * Interceptor opt-in que registra atividade de rotas marcadas com
 * `@TrackActivity()`. Roda DEPOIS dos guards, então `req.user` já está
 * resolvido. Custo no path: lookup de metadata + enqueue assíncrono no
 * `UserActivityService` (push em array, sem await).
 *
 * Não é registrado globalmente — só processa rotas com a metadata. Pra
 * cobrir tudo seria preciso opt-out (overhead em rotas internas/cron) —
 * preferimos a abordagem inversa.
 */
@Injectable()
export class TrackActivityInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly activity: UserActivityService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<TrackActivityOptions | undefined>(
      TRACK_ACTIVITY_KEY,
      context.getHandler(),
    );

    // Sem metadata = rota não opt-in. Pass-through puro, custo zero.
    if (!options) return next.handle();

    const req = context
      .switchToHttp()
      .getRequest<ExpressRequest & { user?: { id?: string } }>();
    const startedAt = Date.now();

    const enqueue = (status: number, errored: boolean) => {
      // Mesmo se trackErrors=false, ainda assim ignoramos erro — mas só
      // quando errored=true. Sucesso (errored=false) sempre passa.
      if (errored && options.trackErrors === false) return;

      try {
        this.activity.record({
          userId: req.user?.id ?? null,
          sessionId: this.extractSessionId(req),
          ip: getClientIp(req) || null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
          source: UserActivitySource.BACKEND,
          category: options.category,
          action: options.action,
          path: this.resolvePath(req),
          referrer:
            (req.headers['referer'] as string | undefined) ??
            (req.headers['referrer'] as string | undefined) ??
            null,
          metadata: {
            method: req.method,
            statusCode: status,
            durationMs: Date.now() - startedAt,
            ...(errored ? { errored: true } : {}),
          },
        });
      } catch {
        // Telemetria nunca quebra o request principal.
      }
    };

    return next.handle().pipe(
      tap(() => {
        const res = context.switchToHttp().getResponse<{ statusCode?: number }>();
        enqueue(res.statusCode ?? 200, false);
      }),
      catchError((err: unknown) => {
        const status =
          (err as { status?: number; getStatus?: () => number })?.getStatus?.() ??
          (err as { status?: number })?.status ??
          500;
        enqueue(status, true);
        return throwError(() => err);
      }),
    );
  }

  /**
   * `sessionId` pode vir como header `x-session-id` (preferido — funciona
   * em todas as rotas) ou no body (fallback pra clients que não controlam
   * headers, raro).
   */
  private extractSessionId(req: ExpressRequest): string | null {
    const fromHeader = req.headers['x-session-id'];
    if (typeof fromHeader === 'string' && fromHeader.length > 0) {
      return fromHeader.slice(0, 64);
    }
    const body = (req as ExpressRequest & { body?: { sessionId?: unknown } })
      .body;
    if (body && typeof body.sessionId === 'string' && body.sessionId.length > 0) {
      return body.sessionId.slice(0, 64);
    }
    return null;
  }

  /**
   * `originalUrl` preserva o prefixo do router (ex: `/api/v1/...`) e a
   * querystring crua. Truncamos pra evitar log de URL gigante.
   */
  private resolvePath(req: ExpressRequest): string {
    const raw = req.originalUrl || req.url || '';
    return raw.length > 500 ? raw.slice(0, 500) : raw;
  }
}
