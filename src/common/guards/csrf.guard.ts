import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';

const CSRF_SECRET_COOKIE = 'csrf_secret';
const CSRF_TOKEN_HEADER = 'x-csrf-token';

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const csrfSecret = request.cookies?.[CSRF_SECRET_COOKIE];
    const csrfToken = request.headers[CSRF_TOKEN_HEADER] as string;

    console.log('🔒 CSRF Debug:', {
      csrfSecret: csrfSecret ? 'present' : 'missing',
      csrfToken: csrfToken ? 'present' : 'missing',
      cookies: Object.keys(request.cookies || {}),
      headers: Object.keys(request.headers)
    });

    if (!csrfSecret || !csrfToken) {
      throw new ForbiddenException('CSRF token inválido ou ausente');
    }

    if (!this.verifyCsrfToken(csrfSecret, csrfToken)) {
      throw new ForbiddenException('CSRF token inválido');
    }

    return true;
  }

  private verifyCsrfToken(secret: string, token: string): boolean {
    try {
      const [timestamp, signature] = token.split('.');
      if (!timestamp || !signature) return false;

      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(timestamp)
        .digest('hex');

      return crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expectedSignature, 'hex')
      );
    } catch (error) {
      return false;
    }
  }
}
