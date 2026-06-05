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

    const enqueue = (status: number, errored: boolean, responseBody?: unknown) => {
      // Mesmo se trackErrors=false, ainda assim ignoramos erro — mas só
      // quando errored=true. Sucesso (errored=false) sempre passa.
      if (errored && options.trackErrors === false) return;

      try {
        // Vínculo com o domínio pra agregações por evento (funil de compra):
        //  - `eventId` direto do body (reserve) ou do payload de resposta;
        //  - `orderId` do path param — presente mesmo em FALHA (4xx/5xx),
        //    permite resolver o evento via join Order na leitura.
        const eventId =
          this.extractUuid((req.body as Record<string, unknown>)?.eventId) ??
          this.extractEventIdFromResponse(responseBody);
        const orderId = this.extractUuid(
          (req.params as Record<string, unknown>)?.orderId,
        );

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
            ...(eventId ? { eventId } : {}),
            ...(orderId ? { orderId } : {}),
            ...(errored ? { errored: true } : {}),
          },
        });
      } catch {
        // Telemetria nunca quebra o request principal.
      }
    };

    return next.handle().pipe(
      tap((body) => {
        const res = context.switchToHttp().getResponse<{ statusCode?: number }>();
        enqueue(res.statusCode ?? 200, false, body);
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

  /** Aceita apenas UUID v1–v5 — nunca loga valor arbitrário vindo do cliente. */
  private extractUuid(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
      ? value
      : null;
  }

  /**
   * Procura `eventId` nos shapes usuais de resposta dos controllers
   * (`{ data: order }`, order plano, `{ data: { event: { id } } }`).
   * Best-effort — ausência não é erro.
   */
  private extractEventIdFromResponse(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const root = body as Record<string, unknown>;
    const data =
      root.data && typeof root.data === 'object'
        ? (root.data as Record<string, unknown>)
        : root;
    const event =
      data.event && typeof data.event === 'object'
        ? (data.event as Record<string, unknown>)
        : null;
    return (
      this.extractUuid(data.eventId) ?? this.extractUuid(event?.id ?? null)
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
