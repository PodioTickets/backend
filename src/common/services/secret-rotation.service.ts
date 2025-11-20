import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import * as crypto from 'crypto';

@Injectable()
export class SecretRotationService implements OnModuleInit {
  private readonly logger = new Logger(SecretRotationService.name);
  private currentSecrets: Map<string, string> = new Map();
  private secretHistory: Map<string, string[]> = new Map();

  constructor(
    private configService: ConfigService,
    private schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit() {
    this.initializeSecrets();
    this.scheduleSecretRotation();
  }

  private initializeSecrets() {
    // Inicializar secrets principais
    const secrets = [
      'JWT_SECRET',
      'SESSION_SECRET',
      'API_BYPASS_SECRET',
      'CSRF_SECRET',
      'ENCRYPTION_KEY',
    ];

    for (const secretName of secrets) {
      const currentSecret = this.configService.get<string>(secretName);
      if (currentSecret) {
        this.currentSecrets.set(secretName, currentSecret);
        this.secretHistory.set(secretName, [currentSecret]);
        this.logger.log(`✅ Initialized secret: ${secretName}`);
      } else {
        // Gerar secret se não existir
        const generatedSecret = this.generateSecureSecret(32);
        this.currentSecrets.set(secretName, generatedSecret);
        this.secretHistory.set(secretName, [generatedSecret]);
        this.logger.warn(`⚠️ Generated new secret for ${secretName} - consider setting in environment variables`);
      }
    }
  }

  private scheduleSecretRotation() {
    // Rotacionar JWT secret a cada 24 horas
    const jwtRotationJob = setInterval(() => {
      this.rotateSecret('JWT_SECRET');
    }, 24 * 60 * 60 * 1000); // 24 horas

    // Rotacionar session secret a cada 12 horas
    const sessionRotationJob = setInterval(() => {
      this.rotateSecret('SESSION_SECRET');
    }, 12 * 60 * 60 * 1000); // 12 horas

    // Rotacionar API bypass secret a cada 48 horas
    const apiBypassRotationJob = setInterval(() => {
      this.rotateSecret('API_BYPASS_SECRET');
    }, 48 * 60 * 60 * 1000); // 48 horas

    this.schedulerRegistry.addInterval('jwt-secret-rotation', jwtRotationJob);
    this.schedulerRegistry.addInterval('session-secret-rotation', sessionRotationJob);
    this.schedulerRegistry.addInterval('api-bypass-secret-rotation', apiBypassRotationJob);

    this.logger.log('✅ Secret rotation jobs scheduled');
  }

  private rotateSecret(secretName: string) {
    const newSecret = this.generateSecureSecret(32);
    const oldSecret = this.currentSecrets.get(secretName);

    // Atualizar secret atual
    this.currentSecrets.set(secretName, newSecret);

    // Adicionar ao histórico (manter últimos 5)
    const history = this.secretHistory.get(secretName) || [];
    history.unshift(newSecret); // Adicionar no início
    if (history.length > 5) {
      history.splice(5); // Manter apenas os últimos 5
    }
    this.secretHistory.set(secretName, history);

    this.logger.log(`🔄 Rotated secret: ${secretName}`);
    this.logger.debug(`Old secret hash: ${this.hashSecret(oldSecret)}`);
    this.logger.debug(`New secret hash: ${this.hashSecret(newSecret)}`);
  }

  private generateSecureSecret(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  private hashSecret(secret: string): string {
    return crypto.createHash('sha256').update(secret).digest('hex').substring(0, 8);
  }

  // Método público para obter secret atual
  getSecret(secretName: string): string | undefined {
    return this.currentSecrets.get(secretName);
  }

  // Método para validar secret antigo (útil para transições suaves)
  isValidSecret(secretName: string, secretValue: string): boolean {
    const history = this.secretHistory.get(secretName) || [];
    return history.includes(secretValue);
  }

  // Método para obter todos os secrets válidos (útil para validação)
  getValidSecrets(secretName: string): string[] {
    return this.secretHistory.get(secretName) || [];
  }

  // Método para forçar rotação manual (útil para emergências)
  forceRotateSecret(secretName: string): string | null {
    if (this.currentSecrets.has(secretName)) {
      this.rotateSecret(secretName);
      return this.currentSecrets.get(secretName) || null;
    }
    return null;
  }

  // Método para obter estatísticas de rotação
  getRotationStats(): Record<string, any> {
    const stats: Record<string, any> = {};

    for (const [secretName, history] of this.secretHistory.entries()) {
      stats[secretName] = {
        currentSecretHash: this.hashSecret(this.currentSecrets.get(secretName) || ''),
        totalRotations: history.length - 1, // -1 porque inclui o inicial
        historySize: history.length,
        lastRotation: new Date().toISOString(), // Aproximado
      };
    }

    return stats;
  }

  // Método para validar força de um secret
  validateSecretStrength(secret: string): {
    isValid: boolean;
    score: number;
    feedback: string[];
  } {
    const feedback: string[] = [];
    let score = 0;

    // Comprimento mínimo
    if (secret.length >= 32) {
      score += 25;
    } else if (secret.length >= 16) {
      score += 15;
      feedback.push('Secret should be at least 32 characters for maximum security');
    } else {
      feedback.push('Secret is too short - minimum 16 characters recommended');
    }

    // Caracteres maiúsculos
    if (/[A-Z]/.test(secret)) {
      score += 20;
    } else {
      feedback.push('Secret should contain uppercase letters');
    }

    // Caracteres minúsculos
    if (/[a-z]/.test(secret)) {
      score += 20;
    } else {
      feedback.push('Secret should contain lowercase letters');
    }

    // Dígitos
    if (/\d/.test(secret)) {
      score += 15;
    } else {
      feedback.push('Secret should contain numbers');
    }

    // Caracteres especiais
    if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(secret)) {
      score += 20;
    } else {
      feedback.push('Secret should contain special characters');
    }

    // Verificar se não está em lista de comuns
    const commonSecrets = [
      'password', 'admin', '123456', 'secret', 'token',
      'default', 'test', 'dev', 'local', 'prod'
    ];

    if (commonSecrets.some(common => secret.toLowerCase().includes(common))) {
      score -= 30;
      feedback.push('Secret contains common words - avoid using predictable patterns');
    }

    // Verificar entropia
    const entropy = this.calculateEntropy(secret);
    if (entropy > 100) {
      score += 10;
    } else if (entropy < 50) {
      feedback.push('Secret has low entropy - consider using more random characters');
    }

    return {
      isValid: score >= 70,
      score: Math.max(0, Math.min(100, score)),
      feedback,
    };
  }

  private calculateEntropy(secret: string): number {
    // Cálculo simplificado de entropia
    const charset = new Set(secret.split('')).size;
    const length = secret.length;

    // Entropia = log2(charset^length)
    return Math.log2(Math.pow(charset, length));
  }

  // Método para validar todos os secrets atuais
  validateAllSecrets(): Record<string, any> {
    const results: Record<string, any> = {};

    for (const [secretName, secretValue] of this.currentSecrets.entries()) {
      results[secretName] = this.validateSecretStrength(secretValue);
    }

    return results;
  }
}
