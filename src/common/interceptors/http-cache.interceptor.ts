import { Injectable, ExecutionContext } from '@nestjs/common';
import { CacheInterceptor } from '@nestjs/cache-manager';
import { NO_CACHE } from '../decorators/cache.decorator';
import { Reflector } from '@nestjs/core';
import { Cache } from 'cache-manager';

@Injectable()
export class HttpCacheInterceptor extends CacheInterceptor {
  constructor(cacheManager: Cache, reflector: Reflector) {
    super(cacheManager, reflector);
  }

  trackBy(context: ExecutionContext) {
    const noCache = this.reflector.get(NO_CACHE, context.getHandler());
    if (noCache) return undefined;
    return super.trackBy(context);
  }
}
