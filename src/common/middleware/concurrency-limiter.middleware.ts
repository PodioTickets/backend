import {
  Injectable,
  NestMiddleware,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

@Injectable()
export class ConcurrencyLimiterMiddleware
  implements NestMiddleware, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ConcurrencyLimiterMiddleware.name);
  private readonly activeRequests = new Map<string, number>();
  private readonly maxConcurrentRequests = process.env.NODE_ENV === 'production' ? 5 : 1; // Permitir mais requisições simultâneas em produção
  private readonly requestTimeout = 30000;
  private cleanupInterval: NodeJS.Timeout;

  onModuleInit() {
    this.cleanupInterval = setInterval(() => {
      this.activeRequests.clear();
    }, 5 * 60 * 1000);
  }

  onModuleDestroy() {
    clearInterval(this.cleanupInterval);
  }

  use(req: Request, res: Response, next: NextFunction) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const userId = this.getUserIdentifier(req);
    if (!userId) return next();

    const currentCount = this.activeRequests.get(userId) || 0;

    if (currentCount >= this.maxConcurrentRequests) {
      return res.status(429).json({
        statusCode: 429,
        message: 'Too many concurrent requests. Please try again later.',
      });
    }
    this.activeRequests.set(userId, currentCount + 1);
    const timeoutId = setTimeout(() => {
      const count = this.activeRequests.get(userId) || 0;
      if (count > 0) {
        this.activeRequests.set(userId, count - 1);
        if (count - 1 <= 0) {
          this.activeRequests.delete(userId);
        }
      }
    }, this.requestTimeout);

    res.on('finish', () => {
      clearTimeout(timeoutId);
      const newCount = (this.activeRequests.get(userId) || 1) - 1;
      if (newCount <= 0) {
        this.activeRequests.delete(userId);
      } else {
        this.activeRequests.set(userId, newCount);
      }
    });

    res.on('close', () => {
      clearTimeout(timeoutId);
      const newCount = (this.activeRequests.get(userId) || 1) - 1;
      if (newCount <= 0) {
        this.activeRequests.delete(userId);
      } else {
        this.activeRequests.set(userId, newCount);
      }
    });

    next();
  }

  private getUserIdentifier(req: Request): string | null {
    if (req['telegramUserId']) return `telegram:${req['telegramUserId']}`;
    const telegramInitData = req.headers['x-telegram-init-data'] as string;
    if (telegramInitData) {
      try {
        const userId = this.extractUserIdFromInitData(telegramInitData);
        if (userId) return `telegram:${userId}`;
      } catch (error) {
        this.logger.error(
          'Error extracting user ID from Telegram init data:',
          error,
        );
      }
    }
    const clientIp =
      req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown';
    if (clientIp !== 'unknown') {
      const ipHash = crypto.createHash('sha256').update(clientIp).digest('hex');
      return `ip:${ipHash}`;
    }
    return null;
  }

  private extractUserIdFromInitData(initData: string): number | null {
    try {
      const idRegex = /"id":(\d+)/;
      const idMatch = initData.match(idRegex);
      if (idMatch && idMatch[1]) return parseInt(idMatch[1]);
      const decodedData = decodeURIComponent(initData);
      const urlParams = new URLSearchParams(decodedData);
      const userStr = urlParams.get('user');
      if (!userStr) return null;
      const userIdMatch = userStr.match(idRegex);
      if (userIdMatch) return parseInt(userIdMatch[1]);
      return null;
    } catch (error) {
      this.logger.error(
        'Error extracting user ID from Telegram init data:',
        error,
      );
      return null;
    }
  }
}
