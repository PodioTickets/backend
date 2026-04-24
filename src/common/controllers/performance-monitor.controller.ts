import { Controller, Get } from '@nestjs/common';
import { PerformanceMonitorService } from '../services/performance-monitor.service';
import { NoCache } from '../decorators/cache.decorator';

@Controller('health/performance')
export class PerformanceMonitorController {
  constructor(private readonly performanceMonitorService: PerformanceMonitorService) { }

  @Get()
  @NoCache()
  getPerformanceSnapshot() {
    return this.performanceMonitorService.getSnapshot();
  }
}
