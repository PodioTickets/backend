import { SetMetadata } from '@nestjs/common';
import { UserActivityCategory } from '@prisma/client';

export const TRACK_ACTIVITY_KEY = 'track-activity';

export type TrackActivityOptions = {
  category: UserActivityCategory;
  /**
   * Identificador curto/estável da ação (não usar IDs no string). Ex:
   * `"login"`, `"reserve"`, `"refund"`. O interceptor anexa método HTTP
   * e path normalizado ao metadata automaticamente.
   */
  action: string;
  /**
   * Quando `true` (default), o evento é registrado mesmo se a request
   * falhar (4xx/5xx). Útil pra forense (tentativas de login). Setar pra
   * `false` em rotas onde só sucesso interessa.
   */
  trackErrors?: boolean;
};

/**
 * Marca uma rota pra captura automática de atividade pelo
 * `TrackActivityInterceptor`. Opt-in por endpoint — não usar globalmente
 * (mata performance e vira ruído).
 *
 * Uso:
 * ```ts
 * @Post('reserve')
 * @TrackActivity({ category: 'CHECKOUT', action: 'reserve' })
 * async reserve(...) { ... }
 * ```
 */
export const TrackActivity = (options: TrackActivityOptions) =>
  SetMetadata(TRACK_ACTIVITY_KEY, options);
