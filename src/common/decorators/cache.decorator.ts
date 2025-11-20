import { SetMetadata } from '@nestjs/common';

export const NO_CACHE = 'no-cache';
export const NoCache = () => SetMetadata(NO_CACHE, true);
export const CacheTTL = (ttl: number) => SetMetadata('cache-ttl', ttl);
