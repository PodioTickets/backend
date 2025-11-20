import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class RequestOriginGuard implements CanActivate {
  private readonly allowedOrigins = ['http://localhost:3000'];

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const origin = request.headers.origin;
    const referer = request.headers.referer;

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      if (!this.isValidOrigin(origin, referer)) {
        throw new ForbiddenException('Access denied - Invalid request origin');
      }
    }

    return true;
  }

  private isValidOrigin(origin?: string, referer?: string): boolean {
    if (!origin && referer) {
      try {
        const url = new URL(referer);
        origin = `${url.protocol}//${url.host}`;
      } catch {
        return false;
      }
    }

    if (!origin) return false;

    return this.allowedOrigins.some((allowedOrigin) => {
      return (
        origin === allowedOrigin ||
        origin.startsWith(allowedOrigin) ||
        (allowedOrigin === 'http://localhost:3000' &&
          origin.includes('localhost'))
      );
    });
  }
}
