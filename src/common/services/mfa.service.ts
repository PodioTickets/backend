import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';

@Injectable()
export class MFAService {
  private readonly logger = new Logger(MFAService.name);

  constructor() {}

  // Gerar secret TOTP para um usuário
  async generateTOTPSecret(
    userId: string,
    userEmail: string,
  ): Promise<{
    secret: string;
    qrCodeUrl: string;
    qrCodeDataURL: string;
  }> {
    try {
      // Gerar secret TOTP
      const secret = speakeasy.generateSecret({
        name: `Loot4Fun:${userEmail}`,
        issuer: 'Loot4Fun',
        length: 32,
      });

      // Gerar URL do QR Code
      const qrCodeUrl = speakeasy.otpauthURL({
        secret: secret.ascii,
        label: `Loot4Fun:${userEmail}`,
        issuer: 'Loot4Fun',
        encoding: 'ascii',
      });

      // Gerar QR Code como Data URL
      const qrCodeDataURL = await qrcode.toDataURL(qrCodeUrl);

      this.logger.log(`🔐 Generated TOTP secret for user: ${userId}`);

      return {
        secret: secret.base32,
        qrCodeUrl,
        qrCodeDataURL,
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to generate TOTP secret for user ${userId}:`,
        error,
      );
      throw new BadRequestException('Failed to generate MFA secret');
    }
  }

  // Verificar código TOTP
  verifyTOTPCode(secret: string, token: string): boolean {
    try {
      const isValid = speakeasy.totp.verify({
        secret: secret,
        encoding: 'base32',
        token: token,
        window: 2, // Permite janela de ±1 código (30 segundos antes/atras)
      });

      if (isValid) {
        this.logger.log('✅ TOTP code verified successfully');
      } else {
        this.logger.warn('❌ Invalid TOTP code provided');
      }

      return isValid;
    } catch (error) {
      this.logger.error('❌ Error verifying TOTP code:', error);
      return false;
    }
  }

  // Gerar código TOTP para desenvolvimento/teste
  generateTOTPCode(secret: string): string {
    try {
      return speakeasy.totp({
        secret: secret,
        encoding: 'base32',
      });
    } catch (error) {
      this.logger.error('❌ Error generating TOTP code:', error);
      throw new BadRequestException('Failed to generate TOTP code');
    }
  }

  // Validar formato do secret TOTP
  validateTOTPSecret(secret: string): boolean {
    try {
      // Verificar se é um secret base32 válido
      const decoded = speakeasy.otpauthURL.parse(
        `otpauth://totp/test?secret=${secret}`,
      );
      return !!decoded && decoded.secret === secret;
    } catch {
      return false;
    }
  }

  // Verificar se MFA é obrigatório para um usuário
  isMFARequired(userId: string, userRole: string): boolean {
    // MFA obrigatório para:
    // - Todos os administradores
    // - Usuários com alto valor de transações
    // - Usuários que fazem login de IPs suspeitos

    if (userRole === 'admin' || userRole === 'superadmin') {
      return true;
    }

    // Em produção, implementar lógica baseada em:
    // - Valor total de transações
    // - Frequência de login
    // - IPs de login suspeitos
    // - Tentativas de acesso falhadas

    return false;
  }

  // Gerar backup codes para recuperação
  generateBackupCodes(count: number = 8): string[] {
    const codes: string[] = [];

    for (let i = 0; i < count; i++) {
      // Gerar código alfanumérico de 8 caracteres
      const code = Math.random().toString(36).substring(2, 10).toUpperCase();
      codes.push(code);
    }

    return codes;
  }

  // Hash backup codes para armazenamento seguro
  hashBackupCodes(codes: string[]): string[] {
    const crypto = require('crypto');
    return codes.map((code) =>
      crypto.createHash('sha256').update(code).digest('hex'),
    );
  }

  // Verificar backup code
  verifyBackupCode(code: string, hashedCodes: string[]): boolean {
    const crypto = require('crypto');
    const hashedInput = crypto.createHash('sha256').update(code).digest('hex');

    return hashedCodes.includes(hashedInput);
  }

  // Remover backup code usado
  removeUsedBackupCode(code: string, hashedCodes: string[]): string[] {
    const crypto = require('crypto');
    const hashedInput = crypto.createHash('sha256').update(code).digest('hex');

    return hashedCodes.filter((hashedCode) => hashedCode !== hashedInput);
  }

  // Verificar força do código TOTP
  validateTOTPToken(token: string): { isValid: boolean; error?: string } {
    // Verificar formato básico (6 dígitos)
    if (!/^\d{6}$/.test(token)) {
      return {
        isValid: false,
        error: 'TOTP code must be 6 digits',
      };
    }

    // Verificar se não é uma sequência óbvia
    const sequentialPatterns = [
      '123456',
      '654321',
      '000000',
      '111111',
      '222222',
    ];
    if (sequentialPatterns.includes(token)) {
      return {
        isValid: false,
        error: 'TOTP code cannot be a sequential pattern',
      };
    }

    return { isValid: true };
  }

  // Obter tempo restante para o código atual
  getRemainingTime(): number {
    const now = Math.floor(Date.now() / 1000);
    return 30 - (now % 30);
  }

  // Configurações de MFA para diferentes cenários
  getMFAConfig(scenario: 'admin' | 'user' | 'recovery'): {
    required: boolean;
    backupCodesEnabled: boolean;
    maxAttempts: number;
    lockoutTime: number;
  } {
    switch (scenario) {
      case 'admin':
        return {
          required: true,
          backupCodesEnabled: true,
          maxAttempts: 3,
          lockoutTime: 15 * 60 * 1000, // 15 minutos
        };

      case 'user':
        return {
          required: false, // Opcional por padrão
          backupCodesEnabled: true,
          maxAttempts: 5,
          lockoutTime: 5 * 60 * 1000, // 5 minutos
        };

      case 'recovery':
        return {
          required: true,
          backupCodesEnabled: false, // Não permitir backup codes na recuperação
          maxAttempts: 3,
          lockoutTime: 30 * 60 * 1000, // 30 minutos
        };

      default:
        return {
          required: false,
          backupCodesEnabled: false,
          maxAttempts: 5,
          lockoutTime: 5 * 60 * 1000,
        };
    }
  }
}
