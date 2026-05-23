import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  Prisma,
  UserActivityCategory,
  UserActivitySource,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Evento a ser gravado em UserActivityLog. `userId` opcional cobre o caso
 * anônimo (pré-login) — nesse caso `sessionId` costura a jornada.
 */
export type UserActivityInput = {
  userId?: string | null;
  sessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  source: UserActivitySource;
  category: UserActivityCategory;
  /** Identificador curto da ação. Ex: "page:event/:slug", "click:btn-buy". */
  action: string;
  path?: string | null;
  referrer?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt?: Date;
};

type BufferedEvent = Required<
  Pick<UserActivityInput, 'source' | 'category' | 'action'>
> & {
  userId: string | null;
  sessionId: string | null;
  ip: string | null;
  userAgent: string | null;
  path: string | null;
  referrer: string | null;
  metadata: Prisma.InputJsonValue | null;
  occurredAt: Date;
};

/**
 * Coleta granular de atividade do usuário (participante + organizador + anônimo).
 *
 * Padrão híbrido (memória + flush periódico) — mesmo princípio do
 * PerformanceMonitorService. Path do request paga apenas um `push` no array;
 * I/O acontece fora do hot path, em batch.
 *
 * Trade-offs:
 *  - Crash entre flushes perde até `FLUSH_INTERVAL_MS` de eventos. Aceitável
 *    pra analytics; rotas críticas (CHECKOUT/AUTH) já têm verdade no banco
 *    (Order/User) — o log aqui é evidência de jornada, não fonte fiscal.
 *  - Buffer cap (`MAX_BUFFER_SIZE`) evita OOM se Postgres cair. Excedeu →
 *    drop com warn (fail-open).
 *  - `createMany` é 10x mais barato por linha vs N inserts individuais.
 */
@Injectable()
export class UserActivityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UserActivityService.name);

  // Flush quando atingir N eventos OU passar M ms desde o último — o que
  // vier primeiro. 200 linhas/createMany é o ponto onde latência por linha
  // estabiliza no Postgres (acima disso, ganho marginal).
  private static readonly FLUSH_INTERVAL_MS = 5_000;
  private static readonly FLUSH_THRESHOLD = 200;
  private static readonly MAX_BUFFER_SIZE = 5_000;
  private static readonly MAX_ACTION_LENGTH = 200;
  private static readonly MAX_PATH_LENGTH = 500;
  private static readonly MAX_USER_AGENT_LENGTH = 500;
  private static readonly MAX_METADATA_BYTES = 8 * 1024; // 8 KB por evento

  /**
   * Lista de chaves consideradas PII / segredo. Removidas recursivamente do
   * metadata antes do enqueue. Defesa em profundidade — o front nunca
   * deveria mandar, mas se mandar (extensão maliciosa, debug acidental,
   * etc.) o backend nunca persiste.
   *
   * IMPORTANTE: armazenadas em lowercase porque o lookup faz
   * `key.toLowerCase()` — manter aqui em camelCase quebraria o match.
   */
  private static readonly PII_KEYS = new Set<string>([
    'password',
    'senha',
    'passwd',
    'pwd',
    'token',
    'accesstoken',
    'refreshtoken',
    'jwt',
    'authorization',
    'apikey',
    'secret',
    'cpf',
    'cnpj',
    'documentnumber',
    'documentnumberclean',
    'rg',
    'passport',
    'passaporte',
    'cardnumber',
    'cardnumberclean',
    'pan',
    'cvv',
    'cvc',
    'securitycode',
    'expirationdate',
    'expiry',
    'cardholder',
    'cardholdername',
    'pin',
    'totp',
    'totpsecret',
    'mfasecret',
    'otp',
  ]);

  private buffer: BufferedEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private droppedSinceLastLog = 0;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, UserActivityService.FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Flush final pra capturar o que ficou desde o último tick.
    await this.flush();
  }

  /**
   * Enfileira um evento. Fire-and-forget — síncrono, sem await. Custo no
   * path do request: 1 push em array + sanitização.
   *
   * Defensivo contra qualquer erro de input: nunca lança. Log de
   * atividade não pode quebrar o fluxo principal.
   */
  record(input: UserActivityInput): void {
    try {
      if (this.buffer.length >= UserActivityService.MAX_BUFFER_SIZE) {
        this.droppedSinceLastLog += 1;
        // Não logamos cada drop — vira ruído. Acumula contagem e logga a
        // cada flush.
        return;
      }

      const action = this.truncate(
        input.action,
        UserActivityService.MAX_ACTION_LENGTH,
      );
      if (!action) return; // sem action útil, nada a logar

      this.buffer.push({
        userId: input.userId ?? null,
        sessionId: input.sessionId
          ? this.truncate(input.sessionId, 64)
          : null,
        ip: input.ip ?? null,
        userAgent: input.userAgent
          ? this.truncate(input.userAgent, UserActivityService.MAX_USER_AGENT_LENGTH)
          : null,
        source: input.source,
        category: input.category,
        action,
        path: input.path
          ? this.truncate(input.path, UserActivityService.MAX_PATH_LENGTH)
          : null,
        referrer: input.referrer
          ? this.truncate(input.referrer, UserActivityService.MAX_PATH_LENGTH)
          : null,
        metadata: this.sanitizeMetadata(input.metadata),
        occurredAt: input.occurredAt ?? new Date(),
      });

      if (this.buffer.length >= UserActivityService.FLUSH_THRESHOLD) {
        // Threshold atingido: dispara flush sem esperar o timer.
        void this.flush();
      }
    } catch (err) {
      // Nunca propagar. Mesmo se a sanitização explodir num shape exótico,
      // o request principal não pode quebrar por causa de telemetria.
      this.logger.warn(`record() falhou: ${(err as Error).message}`);
    }
  }

  /**
   * Para testes / introspection. Não usar em código de produção.
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Escreve o buffer no Postgres em um único `createMany`. Re-entrante:
   * se já está flushando, retorna sem-op (o tick atual cuida).
   */
  private async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.buffer.length === 0) return;

    this.flushing = true;
    // Drena o buffer ANTES do await. Novos records durante o I/O vão pro
    // próximo batch — sem race.
    const batch = this.buffer;
    this.buffer = [];

    try {
      await this.prisma.getWriteClient().userActivityLog.createMany({
        data: batch.map((e) => ({
          userId: e.userId,
          sessionId: e.sessionId,
          ip: e.ip,
          userAgent: e.userAgent,
          source: e.source,
          category: e.category,
          action: e.action,
          path: e.path,
          referrer: e.referrer,
          // Prisma exige InputJsonValue OU JsonNull (não aceita literal null
          // em coluna JSONB nullable). Sem metadata → JsonNull.
          metadata: e.metadata ?? Prisma.JsonNull,
          occurredAt: e.occurredAt,
        })),
      });

      if (this.droppedSinceLastLog > 0) {
        this.logger.warn(
          `UserActivity buffer overflow: ${this.droppedSinceLastLog} eventos dropados desde o último flush`,
        );
        this.droppedSinceLastLog = 0;
      }
    } catch (err) {
      // Postgres caiu, schema drift, qualquer coisa: NÃO recolocar no
      // buffer (poderia inflar indefinidamente). Loga e segue.
      this.logger.error(
        `flush UserActivity falhou (${batch.length} eventos perdidos): ${
          (err as Error).message
        }`,
      );
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Remove chaves PII recursivamente e impõe limite de tamanho. Aceita
   * objetos, arrays e primitivos. Retorna null se input vazio ou só PII.
   */
  private sanitizeMetadata(
    value: unknown,
  ): Prisma.InputJsonValue | null {
    if (value === null || value === undefined) return null;

    const sanitized = this.stripPii(value);
    if (sanitized === undefined) return null;

    // Limite de tamanho como última barreira contra payload abusivo. Aqui
    // poderia ser truncamento esperto, mas pra telemetria simples soltar
    // o evento inteiro é mais seguro que persistir lixo cortado.
    try {
      const serialized = JSON.stringify(sanitized);
      if (serialized.length > UserActivityService.MAX_METADATA_BYTES) {
        return { _truncated: true, _originalSizeBytes: serialized.length };
      }
    } catch {
      return null;
    }

    return sanitized as Prisma.InputJsonValue;
  }

  private stripPii(value: unknown, depth = 0): unknown {
    // Limite de profundidade contra payloads circulares / DoS por nesting.
    if (depth > 8) return undefined;

    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      // Strings muito longas também merecem corte (log de URL gigante etc.).
      return value.length > 2000 ? value.slice(0, 2000) : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;

    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        const cleaned = this.stripPii(item, depth + 1);
        if (cleaned !== undefined) out.push(cleaned);
      }
      return out;
    }

    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(obj)) {
        // Match case-insensitive contra a denylist. Strict equality não
        // basta — front pode mandar "CPF" vs "cpf".
        if (UserActivityService.PII_KEYS.has(key.toLowerCase())) continue;
        const cleaned = this.stripPii(raw, depth + 1);
        if (cleaned !== undefined) out[key] = cleaned;
      }
      return out;
    }

    // Tipos não serializáveis (function, symbol, bigint) — descarta.
    return undefined;
  }

  private truncate(value: string, max: number): string {
    if (!value) return '';
    return value.length > max ? value.slice(0, max) : value;
  }
}
