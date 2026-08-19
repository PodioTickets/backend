import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

@Injectable()
export class OrdersRedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersRedisService.name);
  private client: ReturnType<typeof createClient> | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client?.isOpen) {
      await this.client.quit().catch(() => undefined);
    }
  }

  private async connect(): Promise<void> {
    const enabled =
      this.configService.get<string>('REDIS_ENABLED') === 'true' &&
      !!this.configService.get<string>('REDIS_HOST');
    if (!enabled) return;

    try {
      const c = createClient({
        socket: {
          host: this.configService.get<string>('REDIS_HOST')!,
          port: this.configService.get<number>('REDIS_PORT', 6379),
        },
        password:
          this.configService.get<string>('REDIS_PASSWORD') || undefined,
        database: this.configService.get<number>('REDIS_DB', 0),
      });
      c.on('error', (e: Error) =>
        this.logger.warn(`orders-redis: ${e.message}`),
      );
      await c.connect();
      this.client = c;
      this.logger.log('OrdersRedis connected');
    } catch (e: any) {
      this.logger.warn(
        `OrdersRedis unavailable, falling back to in-memory: ${e.message}`,
      );
    }
  }

  /**
   * Rate limit: sliding window counter.
   * Returns false if the user has exceeded the limit within the window.
   * Returns true (allow) when Redis is unavailable (fail-open).
   */
  async checkRateLimit(
    userId: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    if (!this.client?.isOpen) return true;
    const key = `orders:rl:${userId}`;
    try {
      const n = Number(await this.client.incr(key));
      if (n === 1) await this.client.expire(key, windowSeconds);
      return n <= limit;
    } catch {
      return true;
    }
  }

  /**
   * Idempotency: retrieve a previously cached response for a key.
   */
  async getIdempotencyResult(
    key: string,
  ): Promise<{ status: number; body: any } | null> {
    if (!this.client?.isOpen) return null;
    try {
      const val = await this.client.get(`orders:idem:${key}`);
      return val ? JSON.parse(val as string) : null;
    } catch {
      return null;
    }
  }

  /**
   * Idempotency: lock ATÔMICO (SET NX) por chave, adquirido ANTES de chamar o gateway.
   * Fecha a corrida de 2 `pay` simultâneos com a MESMA Idempotency-Key: o check de cache +
   * set do resultado não são atômicos, então ambos passavam e a Cielo era chamada DUAS vezes
   * (dupla autorização no cartão / QR PIX órfão). Fail-open: Redis fora → permite (mesma
   * postura do cache de idempotência; o guard atômico do Order segue protegendo o finalize).
   * TTL = rede de segurança contra crash sem release (o `pay` libera no finally).
   */
  async acquireIdempotencyLock(key: string, ttlSeconds = 90): Promise<boolean> {
    if (!this.client?.isOpen) return true;
    try {
      const res = await this.client.set(`orders:idemlock:${key}`, '1', {
        NX: true,
        EX: ttlSeconds,
      });
      return res === 'OK';
    } catch {
      return true; // fail-open
    }
  }

  /** Libera o lock de idempotência (chamado no finally do pay — sucesso OU falha). */
  async releaseIdempotencyLock(key: string): Promise<void> {
    if (!this.client?.isOpen) return;
    try {
      await this.client.del(`orders:idemlock:${key}`);
    } catch {
      // non-fatal: o TTL expira o lock sozinho
    }
  }

  /**
   * Cooldown progressivo pós `cc_rejected_high_risk` no débito MP (recomendação
   * oficial do MP: hard stop — retentar em rajada REFORÇA o sinal de velocity).
   * 1ª ocorrência: 30min · 2ª: 4h · 3ª+: 24h. Contador com TTL 24h. Fail-open
   * sem Redis (mesma postura do resto do service).
   */
  async getMpRiskCooldownUntil(userId: string): Promise<number | null> {
    if (!this.client?.isOpen) return null;
    try {
      const raw = await this.client.get(`orders:mprisk:${userId}`);
      if (!raw) return null;
      const { until } = JSON.parse(raw as string);
      return typeof until === 'number' && until > Date.now() ? until : null;
    } catch {
      return null;
    }
  }

  /** Registra uma recusa de risco do MP e arma/estende o cooldown progressivo. */
  async registerMpRiskRejection(userId: string): Promise<void> {
    if (!this.client?.isOpen) return;
    try {
      const key = `orders:mprisk:${userId}`;
      const raw = await this.client.get(key);
      const prev = raw ? JSON.parse(raw as string) : { count: 0 };
      const count = (Number(prev.count) || 0) + 1;
      const waitMs = count === 1 ? 30 * 60_000 : count === 2 ? 4 * 3_600_000 : 24 * 3_600_000;
      await this.client.set(key, JSON.stringify({ count, until: Date.now() + waitMs }), {
        EX: 86_400,
      });
    } catch {
      // non-fatal
    }
  }

  /**
   * Idempotency: store a response for 24 h.
   */
  async setIdempotencyResult(
    key: string,
    status: number,
    body: any,
  ): Promise<void> {
    if (!this.client?.isOpen) return;
    try {
      await this.client.set(
        `orders:idem:${key}`,
        JSON.stringify({ status, body }),
        { EX: 86400 },
      );
    } catch {
      // non-fatal
    }
  }
}
