import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { monitorEventLoopDelay, performance } from 'perf_hooks';

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

@Injectable()
export class PerformanceMonitorService implements OnModuleDestroy {
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

  constructor() {
    this.loopDelay.enable();
  }

  onModuleDestroy() {
    this.loopDelay.disable();
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

  private normalizePath(path: string): string {
    return path
      .replace(/\?.*$/, '')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':uuid')
      .replace(/\/\d+(?=\/|$)/g, '/:id');
  }
}
