import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CdnService {
  private readonly logger = new Logger(CdnService.name);
  private readonly cdnUrl: string | null;
  private readonly enabled: boolean;

  constructor(private configService: ConfigService) {
    this.cdnUrl = this.configService.get<string>('CDN_URL') || null;
    this.enabled = !!this.cdnUrl && this.configService.get<string>('CDN_ENABLED') === 'true';
    
    if (this.enabled) {
      this.logger.log(`CDN enabled: ${this.cdnUrl}`);
    } else {
      this.logger.warn('CDN disabled - using local storage');
    }
  }

  /**
   * Retorna URL completa do asset usando CDN ou caminho local
   */
  getAssetUrl(path: string): string {
    if (!path) return path;
    
    // Se já é URL absoluta, retornar como está
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }

    if (this.enabled && this.cdnUrl) {
      // Remover barra inicial se existir
      const cleanPath = path.startsWith('/') ? path.slice(1) : path;
      return `${this.cdnUrl}/${cleanPath}`;
    }

    // Retornar caminho relativo para servir localmente
    return path.startsWith('/') ? path : `/${path}`;
  }

  /**
   * Verifica se CDN está habilitado
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Retorna URL base do CDN
   */
  getBaseUrl(): string | null {
    return this.cdnUrl;
  }
}

