import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { CacheRedisService } from './cache-redis.service';

type RequestSample = {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
};

type RouteMetric = {
  key: string;
  method: string;
  path: string;
  count: number;
  errorCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
  buckets: number[];
};

/**
 * Shape persistido no Redis. `version` permite evoluir o shape sem ler
 * dados incompatíveis (mismatch → ignora e começa do zero).
 */
type PersistedMetrics = {
  version: 1;
  totalRequests: number;
  totalErrors: number;
  totalDurationMs: number;
  globalBuckets: number[];
  routes: RouteMetric[];
  persistedAt: string;
};

@Injectable()
export class PerformanceMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PerformanceMonitorService.name);
  private readonly startedAt = Date.now();
  private readonly latencyBucketsMs = [25, 50, 100, 250, 500, 1000, 3000, 10000];
  private readonly maxRouteKeys = 500;
  private readonly routeMetrics = new Map<string, RouteMetric>();

  private totalRequests = 0;
  private totalErrors = 0;
  private totalDurationMs = 0;
  private readonly globalBuckets: number[] = Array(this.latencyBucketsMs.length + 1).fill(0);

  private readonly loopDelay = monitorEventLoopDelay({ resolution: 20 });
  private previousElu = performance.eventLoopUtilization();

  // ── Persistência (Redis) ──────────────────────────────────────────────────
  // Chave única (single-instance). Se evoluir pra multi-instance, prefixar
  // com instanceId e agregar no read.
  private static readonly REDIS_KEY = 'perf:monitor:v1';
  private static readonly TTL_SECONDS = 30 * 24 * 60 * 60; // 30 dias
  private static readonly FLUSH_INTERVAL_MS = 30_000;       // 30s
  private flushTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private readonly cache: CacheRedisService) {
    this.loopDelay.enable();
  }

  async onModuleInit(): Promise<void> {
    // Hidratar contadores de uma execução anterior. Se Redis estiver fora
    // (fail-open do CacheRedisService), retorna null → começa do zero.
    await this.hydrateFromRedis();
    this.flushTimer = setInterval(() => {
      void this.flushToRedis();
    }, PerformanceMonitorService.FLUSH_INTERVAL_MS);
    // `unref` evita que o timer segure o event loop no shutdown.
    this.flushTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.loopDelay.disable();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Flush final pra capturar tudo que ficou desde o último tick.
    await this.flushToRedis();
  }

  recordRequest(sample: RequestSample): void {
    if (sample.path.startsWith('/api/v1/health/performance')) return;

    this.totalRequests += 1;
    this.totalDurationMs += sample.durationMs;
    if (sample.statusCode >= 500) {
      this.totalErrors += 1;
    }

    const normalizedPath = this.normalizePath(sample.path);
    const routeKey = `${sample.method} ${normalizedPath}`;

    let metric = this.routeMetrics.get(routeKey);
    if (!metric) {
      if (this.routeMetrics.size >= this.maxRouteKeys) {
        const firstKey = this.routeMetrics.keys().next().value as string | undefined;
        if (firstKey) this.routeMetrics.delete(firstKey);
      }
      metric = {
        key: routeKey,
        method: sample.method,
        path: normalizedPath,
        count: 0,
        errorCount: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        buckets: Array(this.latencyBucketsMs.length + 1).fill(0),
      };
      this.routeMetrics.set(routeKey, metric);
    }

    metric.count += 1;
    metric.totalDurationMs += sample.durationMs;
    metric.maxDurationMs = Math.max(metric.maxDurationMs, sample.durationMs);
    if (sample.statusCode >= 500) {
      metric.errorCount += 1;
    }

    this.incrementBucket(metric.buckets, sample.durationMs);
    this.incrementBucket(this.globalBuckets, sample.durationMs);

    // Marca pra flush no próximo tick. Sem custo extra por request (sem
    // I/O — apenas seta o flag).
    this.dirty = true;
  }

  getSnapshot() {
    const uptimeSeconds = process.uptime();
    const memory = process.memoryUsage();
    const elu = performance.eventLoopUtilization(this.previousElu);
    this.previousElu = performance.eventLoopUtilization();

    const avgLatencyMs = this.totalRequests > 0 ? this.totalDurationMs / this.totalRequests : 0;
    const p95LatencyMs = this.estimatePercentile(this.globalBuckets, 0.95);

    const topSlowRoutes = Array.from(this.routeMetrics.values())
      .filter((metric) => metric.count >= 5)
      .map((metric) => ({
        method: metric.method,
        path: metric.path,
        count: metric.count,
        errorRate: metric.count > 0 ? metric.errorCount / metric.count : 0,
        avgLatencyMs: metric.totalDurationMs / metric.count,
        maxLatencyMs: metric.maxDurationMs,
      }))
      .sort((a, b) => b.avgLatencyMs - a.avgLatencyMs)
      .slice(0, 20);

    return {
      collectedAt: new Date().toISOString(),
      uptimeSeconds,
      requests: {
        total: this.totalRequests,
        errors5xx: this.totalErrors,
        errorRate: this.totalRequests > 0 ? this.totalErrors / this.totalRequests : 0,
        reqPerSecond: uptimeSeconds > 0 ? this.totalRequests / uptimeSeconds : 0,
      },
      latencyMs: {
        average: avgLatencyMs,
        p95Approx: p95LatencyMs,
      },
      eventLoop: {
        utilization: elu.utilization,
        active: elu.active,
        idle: elu.idle,
        delayMs: {
          min: this.nanosecondsToMs(this.loopDelay.min),
          mean: this.nanosecondsToMs(this.loopDelay.mean),
          p95: this.nanosecondsToMs(this.loopDelay.percentile(95)),
          max: this.nanosecondsToMs(this.loopDelay.max),
        },
      },
      memoryBytes: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
      },
      cpu: {
        userMicros: process.cpuUsage().user,
        systemMicros: process.cpuUsage().system,
      },
      topSlowRoutes,
    };
  }

  private incrementBucket(targetBuckets: number[], durationMs: number) {
    const idx = this.latencyBucketsMs.findIndex((limit) => durationMs <= limit);
    if (idx >= 0) {
      targetBuckets[idx] += 1;
      return;
    }
    targetBuckets[targetBuckets.length - 1] += 1;
  }

  private estimatePercentile(targetBuckets: number[], percentile: number): number {
    const total = targetBuckets.reduce((acc, value) => acc + value, 0);
    if (total === 0) return 0;

    const threshold = Math.ceil(total * percentile);
    let cumulative = 0;

    for (let i = 0; i < targetBuckets.length; i++) {
      cumulative += targetBuckets[i];
      if (cumulative >= threshold) {
        return this.latencyBucketsMs[i] ?? this.latencyBucketsMs[this.latencyBucketsMs.length - 1];
      }
    }

    return this.latencyBucketsMs[this.latencyBucketsMs.length - 1];
  }

  private nanosecondsToMs(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value / 1_000_000;
  }

  /**
   * Lê o snapshot persistido e re-popula contadores em memória. Defensivo:
   * - Sem Redis → null → mantém zero.
   * - Shape incompatível → ignora e logga (sem quebrar boot).
   * - Buckets com tamanho divergente → ignora (mudou a config de
   *   `latencyBucketsMs` desde o último persist).
   */
  private async hydrateFromRedis(): Promise<void> {
    const persisted = await this.cache.getJson<PersistedMetrics>(
      PerformanceMonitorService.REDIS_KEY,
    );
    if (!persisted) return;
    if (persisted.version !== 1) {
      this.logger.warn(`perf snapshot version mismatch (${persisted.version}), ignorando`);
      return;
    }
    if (
      !Array.isArray(persisted.globalBuckets) ||
      persisted.globalBuckets.length !== this.globalBuckets.length
    ) {
      this.logger.warn('perf snapshot bucket shape mismatch, ignorando');
      return;
    }

    this.totalRequests = persisted.totalRequests ?? 0;
    this.totalErrors = persisted.totalErrors ?? 0;
    this.totalDurationMs = persisted.totalDurationMs ?? 0;
    for (let i = 0; i < this.globalBuckets.length; i++) {
      this.globalBuckets[i] = persisted.globalBuckets[i] ?? 0;
    }

    for (const route of persisted.routes ?? []) {
      // Defensivo contra buckets antigos de tamanho diferente
      if (!Array.isArray(route.buckets) || route.buckets.length !== this.globalBuckets.length) {
        continue;
      }
      this.routeMetrics.set(route.key, {
        key: route.key,
        method: route.method,
        path: route.path,
        count: route.count,
        errorCount: route.errorCount,
        totalDurationMs: route.totalDurationMs,
        maxDurationMs: route.maxDurationMs,
        buckets: [...route.buckets],
      });
    }
    this.logger.log(
      `perf monitor hidratado do Redis: ${this.totalRequests} reqs, ${this.routeMetrics.size} rotas`,
    );
  }

  /**
   * Escreve snapshot no Redis se houve mudança desde o último flush. Sem
   * mudança → no-op (evita escrita inútil quando o server está ocioso).
   * Single SET com TTL — operação atômica do lado do Redis.
   */
  private async flushToRedis(): Promise<void> {
    if (!this.dirty) return;
    if (!this.cache.isAvailable()) return;
    const snapshot: PersistedMetrics = {
      version: 1,
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      totalDurationMs: this.totalDurationMs,
      globalBuckets: [...this.globalBuckets],
      routes: Array.from(this.routeMetrics.values()).map((m) => ({
        ...m,
        buckets: [...m.buckets],
      })),
      persistedAt: new Date().toISOString(),
    };
    // Marca como limpo ANTES do await: novas requests durante o I/O viram
    // dirty=true de novo e capturadas no próximo flush.
    this.dirty = false;
    await this.cache.setJson(
      PerformanceMonitorService.REDIS_KEY,
      snapshot,
      PerformanceMonitorService.TTL_SECONDS,
    );
  }

  private normalizePath(path: string): string {
    return path
      .replace(/\?.*$/, '')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':uuid')
      .replace(/\/\d+(?=\/|$)/g, '/:id');
  }
}
