import {
  Injectable,
  NestMiddleware,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class SSRFProtectionMiddleware implements NestMiddleware {
  private readonly logger = new Logger(SSRFProtectionMiddleware.name);

  // Lista de domínios permitidos para requests externos
  private readonly allowedDomains = [
    'api.loot4.fun',
    'loot-for-fun.vercel.app',
    'loot4.fun',

    // IPs privados e localhost (apenas para desenvolvimento)
    'localhost',
    '127.0.0.1',
    '::1',

    // Outros domínios confiáveis
    'cdn.jsdelivr.net',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
  ];

  // IPs privadas e reservadas que devem ser bloqueadas
  private readonly blockedIPs = [
    // IPv4 private ranges
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '127.0.0.0/8',
    '169.254.0.0/16',

    // IPv6 private ranges
    '::1/128',
    'fc00::/7',
    'fe80::/10',

    // Outros IPs especiais
    '0.0.0.0',
    '255.255.255.255',
  ];

  use(req: Request, res: Response, next: NextFunction) {
    // Verificar se há URLs nos parâmetros da requisição
    this.validateRequestParameters(req);

    // Verificar se há URLs no body da requisição
    if (req.body && typeof req.body === 'object') {
      this.validateRequestBody(req.body);
    }

    next();
  }

  private validateRequestParameters(req: Request): void {
    // Verificar parâmetros de query
    for (const [key, value] of Object.entries(req.query)) {
      if (this.isURLParameter(key) && typeof value === 'string') {
        this.validateURL(value, `query parameter: ${key}`);
      }
    }

    // Verificar parâmetros de rota
    for (const [key, value] of Object.entries(req.params)) {
      if (this.isURLParameter(key) && typeof value === 'string') {
        this.validateURL(value, `route parameter: ${key}`);
      }
    }
  }

  private validateRequestBody(body: any): void {
    this.traverseObject(body, '', (value: string, path: string) => {
      // Verificar se o valor parece ser uma URL
      if (this.isURLLike(value)) {
        this.validateURL(value, `request body: ${path}`);
      }
    });
  }

  private traverseObject(obj: any, path: string, callback: (value: string, path: string) => void): void {
    if (!obj || typeof obj !== 'object') return;

    for (const [key, value] of Object.entries(obj)) {
      const currentPath = path ? `${path}.${key}` : key;

      if (typeof value === 'string') {
        callback(value, currentPath);
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (typeof item === 'string') {
            callback(item, `${currentPath}[${index}]`);
          } else if (typeof item === 'object') {
            this.traverseObject(item, `${currentPath}[${index}]`, callback);
          }
        });
      } else if (typeof value === 'object') {
        this.traverseObject(value, currentPath, callback);
      }
    }
  }

  private isURLParameter(key: string): boolean {
    const urlParameters = [
      'url', 'uri', 'link', 'redirect', 'callback', 'webhook',
      'endpoint', 'target', 'destination', 'rpc', 'api'
    ];
    return urlParameters.some(param => key.toLowerCase().includes(param));
  }

  private isURLLike(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private validateURL(urlString: string, context: string): void {
    try {
      const url = new URL(urlString);

      // Verificar protocolo
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new BadRequestException(
          `Invalid protocol in ${context}: ${url.protocol}. Only HTTP and HTTPS are allowed.`
        );
      }

      // Verificar hostname
      this.validateHostname(url.hostname, context);

      // Verificar porta (se especificada)
      if (url.port) {
        const port = parseInt(url.port);
        if (port < 1 || port > 65535) {
          throw new BadRequestException(
            `Invalid port in ${context}: ${port}. Port must be between 1 and 65535.`
          );
        }
      }

      this.logger.log(`✅ URL validated: ${urlString} (${context})`);

    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      // Se não conseguir fazer parse da URL, pode não ser uma URL válida
      this.logger.warn(`⚠️ Could not parse URL in ${context}: ${urlString}`);
    }
  }

  private validateHostname(hostname: string, context: string): void {
    // Primeiro verificar se está na lista de domínios permitidos
    if (this.allowedDomains.includes(hostname)) {
      return;
    }

    // Verificar se é um IP e se está bloqueado
    if (this.isIPAddress(hostname)) {
      if (this.isBlockedIP(hostname)) {
        throw new BadRequestException(
          `Access to private/internal IP blocked in ${context}: ${hostname}`
        );
      }
      return;
    }

    // Para domínios não listados, verificar se são domínios públicos válidos
    if (!this.isValidPublicDomain(hostname)) {
      throw new BadRequestException(
        `Invalid or untrusted hostname in ${context}: ${hostname}`
      );
    }
  }

  private isIPAddress(hostname: string): boolean {
    // IPv4 regex
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    // IPv6 regex simplificado
    const ipv6Regex = /^([0-9a-fA-F:]+)$/;

    return ipv4Regex.test(hostname) || ipv6Regex.test(hostname);
  }

  private isBlockedIP(ip: string): boolean {
    // Para simplificar, verificar apenas ranges IPv4 mais comuns
    const parts = ip.split('.');
    if (parts.length !== 4) return false;

    const [a, b] = parts.map(Number);

    // 10.0.0.0/8
    if (a === 10) return true;

    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;

    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;

    // 127.0.0.0/8
    if (a === 127) return true;

    // 169.254.0.0/16 (APIPA)
    if (a === 169 && b === 254) return true;

    return false;
  }

  private isValidPublicDomain(hostname: string): boolean {
    // Verificações básicas de domínio público
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/;

    if (!domainRegex.test(hostname)) {
      return false;
    }

    // Verificar se não contém caracteres suspeitos
    if (hostname.includes('..') || hostname.startsWith('-') || hostname.endsWith('-')) {
      return false;
    }

    // Verificar comprimento
    if (hostname.length > 253) {
      return false;
    }

    return true;
  }
}
