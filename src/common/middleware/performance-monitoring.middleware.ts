import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PerformanceMonitorService } from '../services/performance-monitor.service';

@Injectable()
export class PerformanceMonitoringMiddleware implements NestMiddleware {
  constructor(private readonly performanceMonitorService: PerformanceMonitorService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const endedAt = process.hrtime.bigint();
      const durationMs = Number(endedAt - startedAt) / 1_000_000;

      this.performanceMonitorService.recordRequest({
        method: req.method,
        path: req.originalUrl || req.url || '/',
        statusCode: res.statusCode,
        durationMs,
      });
    });

    next();
  }
}
