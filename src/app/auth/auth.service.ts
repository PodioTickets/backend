import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, DocumentType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import * as geoip from 'geoip-lite';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  EmailLoginDto,
  EmailRegisterDto,
  RefreshTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
} from './dto/auth.dto';
import { EmailService } from '../../common/services/email.service';
import { cleanDocumentNumber } from '../../common/utils/document.util';

type PasswordResetLinkPayload = {
  userId: string;
  email: string;
  accountType: 'USER' | 'ORGANIZER';
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly httpService: HttpService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Valida usuário por email ou CPF
   * @param emailOrCpf Email ou CPF do usuário
   * @param password Senha do usuário
   * @param accountType Tipo de conta (USER ou ORGANIZER). Se não especificado, busca USER por padrão
   */
  async validateUser(
    emailOrCpf: string, 
    password: string, 
    accountType: 'USER' | 'ORGANIZER' = 'USER'
  ): Promise<any> {
    if (!emailOrCpf || typeof emailOrCpf !== 'string') {
      return null;
    }

    if (!password || typeof password !== 'string') {
      return null;
    }

    try {
      // Tentar buscar por email ou CPF com accountType
      const isEmail = emailOrCpf.includes('@');
      let user;

      const prismaWrite = this.prisma.getWriteClient();
      const prismaRead = this.prisma.getReadClient();

      if (isEmail) {
        user = await prismaWrite.user.findUnique({
          where: { 
            email_accountType: {
              email: emailOrCpf,
              accountType: accountType,
            }
          },
          select: {
            id: true,
            email: true,
            password: true,
            isActive: true,
            firstName: true,
            lastName: true,
            documentNumber: true,
            role: true,
            accountType: true,
            mfaEnabled: true,
          },
        });
      } else {
        // Buscar por CPF/documentNumber (limpar formatação)
        const documentNumberClean = emailOrCpf.replace(/\D/g, '');
        user = await prismaWrite.user.findUnique({
          where: {
            documentNumberClean_accountType: {
              documentNumberClean: documentNumberClean,
              accountType: accountType,
            }
          },
          select: {
            id: true,
            email: true,
            password: true,
            isActive: true,
            firstName: true,
            lastName: true,
            documentNumber: true,
            role: true,
            accountType: true,
            mfaEnabled: true,
          },
        });
      }

      if (!user || !user.isActive) {
        return null;
      }

      // Se for ORGANIZER, verificar se é membro de uma organização ativa
      if (accountType === 'ORGANIZER') {
        const member = await prismaRead.organizationMember.findFirst({
          where: { userId: user.id },
          select: {
            id: true,
            organization: { select: { isActive: true } },
          },
        });

        if (!member) {
          return null;
        }

        if (!member.organization.isActive) {
          throw new BadRequestException('Organization is inactive');
        }
      }

      if (!user.password || typeof user.password !== 'string') {
        return null;
      }

      if (password.trim().length === 0 || user.password.trim().length === 0) {
        return null;
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return null;
      }

      const { password: _, ...result } = user;
      return result;
    } catch (error) {
      // Re-throw intentional HTTP exceptions (e.g. inactive organization)
      if (error instanceof BadRequestException || error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error('[AUTH] Error validating user:', error);
      return null;
    }
  }

  async checkUserExists(emailOrCpf: string, accountType: 'USER' | 'ORGANIZER' = 'USER'): Promise<boolean> {
    try {
      const isEmail = emailOrCpf.includes('@');
      const prismaRead = this.prisma.getReadClient();

      if (isEmail) {
        const user = await prismaRead.user.findUnique({
          where: { 
            email_accountType: {
              email: emailOrCpf,
              accountType: accountType,
            }
          },
          select: { id: true, isActive: true },
        });
        return user !== null && user.isActive;
      } else {
        // Buscar por CPF/documentNumber (limpar formatação)
        const documentNumberClean = emailOrCpf.replace(/\D/g, '');
        const user = await prismaRead.user.findUnique({
          where: { 
            documentNumberClean_accountType: {
              documentNumberClean,
              accountType: accountType,
            }
          },
          select: { id: true, isActive: true },
        });
        return user !== null && user.isActive;
      }
    } catch (error) {
      return false;
    }
  }

  async isEmailAvailable(email: string): Promise<boolean> {
    const existing = await this.prisma.getReadClient().user.findFirst({
      where: { email },
      select: { id: true },
    });
    return existing === null;
  }

  async register(registerDto: EmailRegisterDto) {
    try {
      const {
        email,
        password,
        complete_name,
        gender,
        phone,
        reserve_phone,
        dateOfBirth,
        country,
        state,
        city,
        documentType,
        documentNumber,
        sex,
        acceptedTerms,
        acceptedPrivacyPolicy,
        receiveCalendarEvents,
        receivePartnerPromos,
        language,
      } = registerDto;

      // Validar aceite dos termos
      if (!acceptedTerms || !acceptedPrivacyPolicy) {
        throw new BadRequestException(
          'Terms of purchase and privacy policy must be accepted',
        );
      }

      // Verificar se email já existe para conta USER (registro sempre cria conta USER)
      const prismaWrite = this.prisma.getWriteClient();
      const prismaRead = this.prisma.getReadClient();

      const existingUserByEmail = await prismaRead.user.findUnique({
        where: { 
          email_accountType: {
            email,
            accountType: 'USER',
          }
        },
      });

      if (existingUserByEmail) {
        throw new ConflictException('Já existe um usuário com este e-mail');
      }

      // Normalização única do projeto — ver `common/utils/document.util.ts`.
      // CPF: só dígitos. PASSPORT: uppercase + strip não-alfanumérico.
      // Lookup da unique key (documentNumberClean, accountType) precisa
      // bater com o que `user.service.update()` grava — qualquer drift de
      // regra aqui quebra dedupe.
      const normalizeDocClean = (raw: string, type: DocumentType | undefined): string =>
        cleanDocumentNumber(raw, type ?? DocumentType.CPF);

      // Verificar se documento já existe para conta USER (se fornecido)
      if (documentNumber) {
        const documentNumberClean = normalizeDocClean(documentNumber, documentType);
        const existingUserByCpf = await prismaRead.user.findUnique({
          where: {
            documentNumberClean_accountType: {
              documentNumberClean,
              accountType: 'USER',
            }
          },
        });

        if (existingUserByCpf) {
          throw new ConflictException(
            'User with this document number already exists',
          );
        }
      }

      const hashedPassword = await bcrypt.hash(password, 12);

      // Limpar documentNumber para validação de unicidade
      const documentNumberClean = documentNumber ? normalizeDocClean(documentNumber, documentType) : null;

      const user = await prismaWrite.user.create({
        data: {
          email,
          accountType: 'USER', // Registro sempre cria conta de usuário normal
          password: hashedPassword,
          firstName: complete_name ? complete_name.split(' ')[0] : '',
          lastName: complete_name ? complete_name.split(' ').slice(1).join(' ') : '',
          gender,
          phone,
          reservePhone: reserve_phone,
          dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
          country,
          state,
          city,
          documentType,
          documentNumber,
          documentNumberClean,
          acceptedTerms,
          acceptedPrivacyPolicy,
          receiveCalendarEvents: receiveCalendarEvents ?? false,
          receivePartnerPromos: receivePartnerPromos ?? false,
          language: language || 'PT',
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          documentNumber: true,
          role: true,
          isActive: true,
          avatarUrl: true,
        },
      });

      this.emailService.sendWelcomeUser({ email: user.email, firstName: user.firstName })
        .catch((err) => this.logger.warn('Failed to send welcome email:', err));

      return this.login({ ...user, accountType: 'USER' });
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      // Handle Prisma unique constraint violations
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const target = error.meta?.target as string[];
        if (target?.includes('email')) {
          throw new ConflictException('Já existe um usuário com este e-mail');
        }
        if (target?.includes('documentNumber')) {
          throw new ConflictException(
            'User with this document number already exists',
          );
        }
        throw new ConflictException('Usuário já existe');
      }

      // Log do erro completo para debug
      console.error('Registration error:', error);
      throw new BadRequestException(error?.message || 'Falha ao criar usuário');
    }
  }

  /**
   * Verifica se o usuário tem senha definida (login email/senha possível).
   */
  async hasPassword(userId: string): Promise<boolean> {
    const prismaRead = this.prisma.getReadClient();
    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { password: true },
    });
    return !!(user?.password && String(user.password).trim().length > 0);
  }

  async login(user: any, opts?: { userAgent?: string }) {
    // Se o usuário tiver 2FA ativo, emitir desafio MFA em vez de tokens reais
    if (user.mfaEnabled) {
      await this.send2FACode(user.id, user.email, opts);
      const mfaToken = this.jwtService.sign(
        { sub: user.id, mfaPending: true, accountType: user.accountType || 'USER' },
        { expiresIn: '10m' },
      );
      this.logger.log(`Login com MFA iniciado para usuário ${user.id}`);
      return { mfaRequired: true, mfaToken };
    }

    const payload = {
      email: user.email,
      sub: user.id,
      accountType: user.accountType || 'USER', // Incluir accountType no JWT
    };
    try {
      const jwtSecret = this.configService.get<string>('JWT_SECRET');
      if (!jwtSecret) {
        throw new UnauthorizedException('JWT secret not configured');
      }

      const prismaWrite = this.prisma.getWriteClient();
      const accessToken = this.jwtService.sign(payload);
      const refreshToken = await this.createRefreshToken(user.id);

      await prismaWrite.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      return {
        message: 'Login successful',
        success: true,
        data: {
          access_token: accessToken,
          refresh_token: refreshToken,
          user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            documentNumber: user.documentNumber,
            role: user.role,
            accountType: user.accountType || 'USER',
            avatarUrl: user.avatarUrl,
          },
        },
      };
    } catch (error) {
      console.error('Login error:', error);
      throw new UnauthorizedException(
        error?.message || 'Failed to generate tokens',
      );
    }
  }

  /**
   * Verifica o token MFA temporário + código OTP e emite tokens reais de acesso.
   * Chamado por POST /auth/2fa/verify-login após login com mfaEnabled=true.
   */
  async verifyLoginMfa(mfaToken: string, code: string): Promise<any> {
    // Decodifica e valida o token temporário
    let payload: any;
    try {
      payload = this.jwtService.verify(mfaToken);
    } catch {
      throw new UnauthorizedException('Token MFA inválido ou expirado.');
    }

    if (!payload?.mfaPending || !payload?.sub) {
      throw new UnauthorizedException('Token MFA inválido.');
    }

    const userId = payload.sub as string;
    const accountType = (payload.accountType as string) || 'USER';

    // Verifica e consome o código OTP
    await this.verifyAndConsume2FACode(userId, code);

    // Busca dados do usuário para montar a resposta
    const prismaWrite = this.prisma.getWriteClient();
    const user = await prismaWrite.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        documentNumber: true,
        role: true,
        accountType: true,
        avatarUrl: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Usuário não encontrado.');
    }

    const accessPayload = { email: user.email, sub: user.id, accountType };
    const accessToken = this.jwtService.sign(accessPayload);
    const refreshToken = await this.createRefreshToken(user.id);

    await prismaWrite.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    this.logger.log(`Login com MFA concluído para usuário ${user.id}`);

    return {
      message: 'Login successful',
      success: true,
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          documentNumber: user.documentNumber,
          role: user.role,
          accountType: user.accountType || 'USER',
          avatarUrl: user.avatarUrl,
        },
      },
    };
  }

  /**
   * Reenvia o código MFA durante o fluxo de login.
   * Aceita o mfaToken temporário (emitido em login com 2FA ativo) como autenticação.
   */
  async resendLoginMfaCode(mfaToken: string, opts?: { userAgent?: string }): Promise<{ message: string; success: boolean }> {
    let payload: any;
    try {
      payload = this.jwtService.verify(mfaToken);
    } catch {
      throw new UnauthorizedException('Token MFA inválido ou expirado.');
    }

    if (!payload?.mfaPending || !payload?.sub) {
      throw new UnauthorizedException('Token MFA inválido.');
    }

    const userId = payload.sub as string;
    const prismaRead = this.prisma.getReadClient();
    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!user) {
      throw new UnauthorizedException('Usuário não encontrado.');
    }

    await this.send2FACode(userId, user.email, opts);
    return { message: 'Código reenviado para o seu e-mail.', success: true };
  }

  async refreshToken(refreshTokenDto: RefreshTokenDto) {
    try {
      const { refreshToken } = refreshTokenDto;

      // Buscar refresh token no banco (implementar modelo RefreshToken se necessário)
      // Por enquanto, validar diretamente o JWT
      const decoded = this.jwtService.verify(refreshToken, {
        secret:
          this.configService.get<string>('JWT_REFRESH_SECRET') ||
          this.configService.get<string>('JWT_SECRET'),
      });

      const prismaRead = this.prisma.getReadClient();

      const user = await prismaRead.user.findUnique({
        where: { id: decoded.sub },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          isActive: true,
          role: true,
          accountType: true,
        },
      });

      if (!user || !user.isActive) {
        throw new UnauthorizedException('Usuário não encontrado ou inativo');
      }

      const payload = { 
        email: user.email, 
        sub: user.id,
        accountType: user.accountType || 'USER',
      };
      const accessToken = this.jwtService.sign(payload);
      const newRefreshToken = await this.createRefreshToken(user.id);

      return {
        message: 'Token refreshed successfully',
        data: {
          access_token: accessToken,
          refresh_token: newRefreshToken,
        },
      };
    } catch (error) {
      throw new UnauthorizedException('Token de atualização inválido');
    }
  }

  async logout(refreshToken: string) {
    // Implementar invalidação do refresh token se necessário
    // Por enquanto, apenas retornar sucesso
    return { message: 'Logged out successfully' };
  }

  async forgotPassword(forgotPasswordDto: ForgotPasswordDto, accountType: 'USER' | 'ORGANIZER' = 'USER') {
    const emailNorm = forgotPasswordDto.email.trim();
    const prismaRead = this.prisma.getReadClient();

    const generic = {
      success: true,
      message:
        'Se uma conta existir com este e-mail, enviaremos instruções para redefinir a senha.',
    };

    const user = await prismaRead.user.findUnique({
      where: {
        email_accountType: {
          email: emailNorm,
          accountType,
        },
      },
      select: { id: true, email: true, firstName: true, isActive: true },
    });

    if (!user) {
      return generic;
    }

    const hour = Math.floor(Date.now() / (60 * 60 * 1000));
    const rateKey = `forgot_pw:${emailNorm.toLowerCase()}:${accountType}:${hour}`;
    const count = (await this.cacheManager.get<number>(rateKey)) || 0;
    if (count >= 5) {
      return generic;
    }
    await this.cacheManager.set(rateKey, count + 1, 2 * 60 * 60 * 1000);

    try {
      await this.issuePasswordResetCodeForUser(
        { id: user.id, email: user.email, firstName: user.firstName },
        accountType,
      );
    } catch (err) {
      this.logger.error('[AUTH] Falha ao enviar e-mail de recuperação de senha:', err);
    }

    return generic;
  }

  async verifyResetCode(email: string, code: string, accountType: 'USER' | 'ORGANIZER' = 'USER') {
    const cacheKey = `reset_code:${email}:${accountType}`;
    const cached = await this.cacheManager.get<any>(cacheKey);

    if (!cached) {
      throw new BadRequestException('Código inválido ou expirado');
    }

    if (cached.used) {
      throw new BadRequestException('Código já foi utilizado');
    }

    if (new Date(cached.expiresAt) < new Date()) {
      throw new BadRequestException('Código expirado');
    }

    if (cached.attempts >= 5) {
      throw new BadRequestException('Muitas tentativas. Solicite um novo código');
    }

    cached.attempts += 1;
    await this.cacheManager.set(cacheKey, cached, 15 * 60 * 1000);

    if (cached.code !== code) {
      throw new BadRequestException('Código inválido');
    }

    cached.used = true;
    await this.cacheManager.set(cacheKey, cached, 15 * 60 * 1000);

    const resetToken = this.jwtService.sign(
      {
        email,
        accountType,
        userId: cached.userId,
        type: 'password_reset',
      },
      {
        expiresIn: '30m',
      },
    );

    return {
      success: true,
      token: resetToken,
      message: 'Código verificado com sucesso',
    };
  }

  async resendResetCode(email: string, accountType: 'USER' | 'ORGANIZER' = 'USER') {
    const emailNorm = email.trim();
    const prismaRead = this.prisma.getReadClient();

    const generic = {
      success: true,
      message:
        'Se uma conta existir com este e-mail, enviaremos instruções para redefinir a senha.',
    };

    const user = await prismaRead.user.findUnique({
      where: {
        email_accountType: {
          email: emailNorm,
          accountType,
        },
      },
      select: { id: true, email: true, firstName: true, isActive: true },
    });

    if (!user || !user.isActive) {
      return generic;
    }

    const rateLimitKey = `reset_link_resend:${emailNorm.toLowerCase()}:${accountType}`;
    if (await this.cacheManager.get(rateLimitKey)) {
      return generic;
    }
    await this.cacheManager.set(rateLimitKey, true, 60 * 1000);

    try {
      await this.issuePasswordResetCodeForUser(
        { id: user.id, email: user.email, firstName: user.firstName },
        accountType,
      );
    } catch (err) {
      this.logger.error('[AUTH] Falha ao reenviar e-mail de recuperação de senha:', err);
    }

    return {
      success: true,
      message: 'Se o e-mail estiver cadastrado, você receberá um novo código em instantes.',
    };
  }

  async resetPassword(resetPasswordDto: ResetPasswordDto, userAgent?: string, ip?: string) {
    const { token, password } = resetPasswordDto;

    if (password.length < 8) {
      throw new BadRequestException(
        'A senha deve ter no mínimo 8 caracteres',
      );
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
    if (!passwordRegex.test(password)) {
      throw new BadRequestException(
        'A senha deve conter pelo menos uma letra maiúscula, uma minúscula e um número',
      );
    }

    const trimmedToken = token.trim();
    const looksLikeJwt =
      typeof trimmedToken === 'string' && trimmedToken.split('.').length === 3;

    if (!looksLikeJwt) {
      return this.resetPasswordWithOpaqueToken(trimmedToken, password, userAgent, ip);
    }

    let decoded: { type?: string; email?: string; accountType?: string; userId?: string };
    try {
      decoded = this.jwtService.verify(trimmedToken);
    } catch {
      throw new BadRequestException('Token inválido ou expirado');
    }

    if (decoded.type !== 'password_reset') {
      throw new BadRequestException('Token inválido');
    }

    const email = decoded.email as string;
    const accountType = decoded.accountType as 'USER' | 'ORGANIZER';
    const userId = decoded.userId as string;

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const user = await prismaRead.user.findUnique({
      where: {
        email_accountType: {
          email,
          accountType,
        },
      },
    });

    if (!user || user.id !== userId) {
      throw new BadRequestException('Usuário não encontrado');
    }

    if (user.password) {
      const isSamePassword = await bcrypt.compare(password, user.password);
      if (isSamePassword) {
        throw new BadRequestException('A nova senha não pode ser igual à senha atual');
      }
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    await prismaWrite.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        ...(user.isActive ? {} : { isActive: true }),
      },
    });

    await this.invalidatePasswordResetArtifactsForUser(user.id, email, accountType);

    const changedAt = this.formatDateTimePtBR(new Date());
    const device = this.parseDevice(userAgent);
    this.parseLocation(ip ?? '').then((location) =>
      this.emailService.sendPasswordChangedNotification({
        email: user.email,
        firstName: user.firstName,
        changedAt,
        location,
        device,
      }),
    ).catch((err) => this.logger.warn('Falha ao enviar email de senha redefinida:', err));

    return {
      success: true,
      message: 'Senha redefinida com sucesso',
    };
  }

  private async resetPasswordWithOpaqueToken(token: string, password: string, userAgent?: string, ip?: string) {
    const cached = await this.cacheManager.get<PasswordResetLinkPayload>(
      `password_reset_link:${token}`,
    );

    if (!cached) {
      throw new BadRequestException('Token inválido ou expirado');
    }

    const { userId, email, accountType } = cached;
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const user = await prismaRead.user.findUnique({
      where: {
        email_accountType: {
          email,
          accountType,
        },
      },
    });

    if (!user || user.id !== userId) {
      throw new BadRequestException('Usuário não encontrado');
    }

    if (user.password) {
      const isSamePassword = await bcrypt.compare(password, user.password);
      if (isSamePassword) {
        throw new BadRequestException('A nova senha não pode ser igual à senha atual');
      }
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    await prismaWrite.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        ...(user.isActive ? {} : { isActive: true }),
      },
    });

    await this.invalidatePasswordResetArtifactsForUser(user.id, email, accountType);

    const changedAt = this.formatDateTimePtBR(new Date());
    const device = this.parseDevice(userAgent);
    this.parseLocation(ip ?? '').then((location) =>
      this.emailService.sendPasswordChangedNotification({
        email: user.email,
        firstName: user.firstName,
        changedAt,
        location,
        device,
      }),
    ).catch((err) => this.logger.warn('Falha ao enviar email de senha redefinida (opaque):', err));

    return {
      success: true,
      message: 'Senha redefinida com sucesso',
    };
  }

  private getPasswordResetLinkTtlMs(): number {
    const raw = this.configService.get<string>('PASSWORD_RESET_TOKEN_TTL_MS');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000;
  }

  private buildPasswordResetPageUrl(token: string): string {
    const base = (
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000'
    ).replace(/\/$/, '');
    const pathRaw = this.configService.get<string>('PASSWORD_RESET_PATH') || '/reset-password';
    const path = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`;
    return `${base}${path}?token=${encodeURIComponent(token)}`;
  }

  private async invalidatePasswordResetArtifactsForUser(
    userId: string,
    email: string,
    accountType: 'USER' | 'ORGANIZER',
  ): Promise<void> {
    await this.cacheManager.del(`reset_code:${email}:${accountType}`);
    const activeToken = await this.cacheManager.get<string>(
      `password_reset_active:${userId}`,
    );
    if (activeToken) {
      await this.cacheManager.del(`password_reset_link:${activeToken}`);
      await this.cacheManager.del(`password_reset_active:${userId}`);
    }
  }

  // ─── Email / device helpers ─────────────────────────────────────────────

  private generateCode(): { raw: string; display: string } {
    const raw = Math.floor(100000 + Math.random() * 900000).toString();
    return { raw, display: raw };
  }

  private formatDateTimePtBR(date: Date): string {
    const tz = 'America/Sao_Paulo';
    const d = date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: tz });
    const t = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    return `${d} às ${t}`;
  }

  private async parseLocation(ip: string): Promise<string> {
    if (!ip || ip === '—') return '—';
    const cleanIp = ip.replace(/^::ffff:/, '');

    try {
      const token = this.configService.get<string>('IPINFO_TOKEN', 'f5f7bc542bbe40');
      const resp = await firstValueFrom(
        this.httpService.get(
          `https://ipinfo.io/${cleanIp}/json?token=${token}`,
          { timeout: 3000 } as any,
        ),
      );
      const d = resp.data;
      if (d && !d.bogon) {
        if (d.city && d.region) return `${d.city}, ${d.region}`;
        if (d.city) return d.city;
        if (d.country) return d.country;
      }
    } catch {
      // fallback
    }

    try {
      const geo = geoip.lookup(cleanIp);
      if (geo) {
        if (geo.city && geo.region) return `${geo.city}, ${geo.region}`;
        if (geo.city) return geo.city;
        if (geo.country) return geo.country;
      }
    } catch {
      // ignore
    }

    return '—';
  }

  private parseDevice(userAgent?: string): string {
    if (!userAgent) return 'Dispositivo desconhecido';
    const ua = userAgent;
    let browser = 'Navegador';
    if (ua.includes('Edg/')) browser = 'Edge';
    else if (ua.includes('Chrome/')) browser = 'Chrome';
    else if (ua.includes('Firefox/')) browser = 'Firefox';
    else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Safari';
    let os = '';
    if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Mac OS X')) os = 'macOS';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
    else if (ua.includes('Linux')) os = 'Linux';
    return os ? `${browser} no ${os}` : browser;
  }

  private async issuePasswordResetCodeForUser(
    user: { id: string; email: string; firstName: string },
    accountType: 'USER' | 'ORGANIZER',
  ): Promise<void> {
    const { raw, display } = this.generateCode();
    const ttl = 15 * 60 * 1000;
    await this.cacheManager.set(
      `reset_code:${user.email}:${accountType}`,
      {
        code: raw,
        userId: user.id,
        used: false,
        attempts: 0,
        expiresAt: new Date(Date.now() + ttl).toISOString(),
      },
      ttl,
    );
    await this.emailService.sendPasswordResetCode({
      email: user.email,
      firstName: user.firstName,
      code: display,
    });
  }

  private async issuePasswordResetLinkForUser(
    user: { id: string; email: string; firstName: string },
    accountType: 'USER' | 'ORGANIZER',
  ): Promise<void> {
    const ttl = this.getPasswordResetLinkTtlMs();
    const token = crypto.randomBytes(32).toString('hex');
    const payload: PasswordResetLinkPayload = {
      userId: user.id,
      email: user.email,
      accountType,
    };
    const resetUrl = this.buildPasswordResetPageUrl(token);
    console.log('[DEV] Password reset URL:', resetUrl);
    const accountLabel =
      accountType === 'ORGANIZER' ? 'conta de organizador' : 'sua conta PodioGo';

    await this.emailService.sendPasswordResetLink({
      email: user.email,
      firstName: user.firstName,
      resetUrl,
      accountLabel,
    });

    const prevToken = await this.cacheManager.get<string>(
      `password_reset_active:${user.id}`,
    );
    await this.cacheManager.set(`password_reset_link:${token}`, payload, ttl);
    await this.cacheManager.set(`password_reset_active:${user.id}`, token, ttl);
    if (prevToken && prevToken !== token) {
      await this.cacheManager.del(`password_reset_link:${prevToken}`);
    }
  }

  /**
   * Troca a senha do usuário logado. Se já tiver senha, exige currentPassword. Se não tiver (ex.: só Google), só newPassword.
   */
  async changePassword(userId: string, dto: ChangePasswordDto, userAgent?: string, ip?: string) {
    const { currentPassword, newPassword } = dto;

    if (newPassword.length < 8) {
      throw new BadRequestException('A senha deve ter no mínimo 8 caracteres');
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
    if (!passwordRegex.test(newPassword)) {
      throw new BadRequestException(
        'A senha deve conter pelo menos uma letra maiúscula, uma minúscula e um número',
      );
    }

    const prismaRead = this.prisma.getReadClient();
    const prismaWrite = this.prisma.getWriteClient();

    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        password: true,
        email: true,
        accountType: true,
      },
    });

    if (!user) {
      throw new BadRequestException('Usuário não encontrado');
    }

    const userHasPassword = !!(user.password && String(user.password).trim().length > 0);

    if (userHasPassword) {
      if (!currentPassword || typeof currentPassword !== 'string' || currentPassword.trim().length === 0) {
        throw new BadRequestException('Senha atual é obrigatória para trocar a senha');
      }
      const isCurrentValid = await bcrypt.compare(currentPassword, user.password);
      if (!isCurrentValid) {
        throw new UnauthorizedException('Senha atual incorreta');
      }
      const isSamePassword = await bcrypt.compare(newPassword, user.password);
      if (isSamePassword) {
        throw new BadRequestException('A nova senha não pode ser igual à senha atual');
      }
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    const updatedUser = await prismaWrite.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
      select: { firstName: true, email: true },
    });

    await this.invalidatePasswordResetArtifactsForUser(
      user.id,
      user.email,
      user.accountType as 'USER' | 'ORGANIZER',
    );

    const changedAt = this.formatDateTimePtBR(new Date());
    const device = this.parseDevice(userAgent);
    this.parseLocation(ip ?? '').then((location) =>
      this.emailService.sendPasswordChangedNotification({
        email: updatedUser.email,
        firstName: updatedUser.firstName,
        changedAt,
        location,
        device,
      }),
    ).catch((err) => this.logger.warn('Failed to send password changed email:', err));

    return {
      success: true,
      message: 'Senha alterada com sucesso',
    };
  }

  async changeEmail(
    userId: string,
    dto: { newEmail: string; currentPassword: string },
    userAgent?: string,
    ip?: string,
  ) {
    const { newEmail, currentPassword } = dto;

    const prismaRead = this.prisma.getReadClient();

    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, firstName: true, password: true, accountType: true },
    });
    if (!user) throw new BadRequestException('Usuário não encontrado');

    if (!user.password || String(user.password).trim().length === 0) {
      throw new BadRequestException('Conta sem senha local — use a autenticação Google para gerenciar o e-mail');
    }

    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isPasswordValid) throw new UnauthorizedException('Senha incorreta');

    const normalizedEmail = newEmail.toLowerCase().trim();

    if (normalizedEmail === user.email.toLowerCase()) {
      throw new BadRequestException('O novo e-mail deve ser diferente do atual');
    }

    const existing = await prismaRead.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' }, accountType: user.accountType },
      select: { id: true },
    });
    if (existing) throw new BadRequestException('Este e-mail já está em uso');

    // Gerar código e cachear — e-mail ainda NÃO é alterado aqui
    const { raw, display } = this.generateCode();
    const ttl = 15 * 60 * 1000;
    await this.cacheManager.set(
      `email_change:${userId}`,
      {
        newEmail: normalizedEmail,
        oldEmail: user.email,
        firstName: user.firstName,
        code: raw,
        attempts: 0,
        expiresAt: new Date(Date.now() + ttl).toISOString(),
        ip: ip ?? '',
        userAgent: userAgent ?? '',
      },
      ttl,
    );

    this.parseLocation(ip || '').then((location) =>
      this.emailService.sendEmailChangeVerification({
        email: user.email,
        firstName: user.firstName,
        newEmail: normalizedEmail,
        code: display,
        requestDate: this.formatDateTimePtBR(new Date()),
        location,
        device: this.parseDevice(userAgent),
      }),
    ).catch((err) => this.logger.warn('Failed to send email change verification:', err));

    return { success: true, message: 'Código de verificação enviado para o seu e-mail atual. Confirme para concluir a troca.' };
  }

  async verifyEmailChange(userId: string, code: string) {
    const cacheKey = `email_change:${userId}`;
    const cached = await this.cacheManager.get<{
      newEmail: string;
      oldEmail: string;
      firstName: string;
      code: string;
      attempts: number;
      expiresAt: string;
      ip?: string;
      userAgent?: string;
    }>(cacheKey);

    if (!cached) throw new BadRequestException('Código inválido ou expirado');
    if (new Date(cached.expiresAt) < new Date()) throw new BadRequestException('Código expirado');

    if ((cached.attempts ?? 0) >= 5) {
      throw new BadRequestException('Muitas tentativas inválidas. Solicite um novo código');
    }

    cached.attempts = (cached.attempts ?? 0) + 1;
    await this.cacheManager.set(cacheKey, cached, 15 * 60 * 1000);

    if (cached.code !== code) throw new BadRequestException('Código inválido');

    const prismaWrite = this.prisma.getWriteClient();
    await prismaWrite.user.update({
      where: { id: userId },
      data: { email: cached.newEmail },
    });

    await this.cacheManager.del(cacheKey);

    // Notificar email antigo — fire-and-forget
    const changedAt = this.formatDateTimePtBR(new Date());
    this.parseLocation(cached.ip ?? '').then((location) =>
      this.emailService.sendEmailChangedNotification({
        oldEmail: cached.oldEmail,
        newEmail: cached.newEmail,
        firstName: cached.firstName,
        changedAt,
        location,
        device: this.parseDevice(cached.userAgent),
      }),
    ).catch((err) => this.logger.warn('Falha ao enviar notificação de email alterado:', err));

    return { success: true, message: 'E-mail alterado com sucesso.' };
  }

  private async createRefreshToken(userId: string): Promise<string> {
    const payload = { sub: userId };
    const refreshSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ||
      this.configService.get<string>('JWT_SECRET');

    if (!refreshSecret) {
      throw new UnauthorizedException('JWT secret not configured');
    }

    const refreshExpiresIn =
      this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '7d';

    // JWT aceita strings como "7d", "1h", etc. ou números em segundos
    return this.jwtService.sign(payload, {
      secret: refreshSecret,
      expiresIn: refreshExpiresIn,
    } as any);
  }

  /**
   * Valida ou cria usuário a partir dos dados do Google
   * Google login sempre cria conta USER (não organizador)
   */
  async validateGoogleUser(googleUser: any) {
    const prismaWrite = this.prisma.getWriteClient();

    try {
      // Verificar se já existe um usuário com esse googleId (conta USER)
      let user = await prismaWrite.user.findFirst({
        where: { 
          googleId: googleUser.googleId,
          accountType: 'USER',
        },
      });

      if (user) {
        // Atualizar dados se necessário
        if (user.email !== googleUser.email || user.avatarUrl !== googleUser.avatarUrl) {
          user = await prismaWrite.user.update({
            where: { id: user.id },
            data: {
              email: googleUser.email,
              googleEmail: googleUser.email,
              avatarUrl: googleUser.avatarUrl || user.avatarUrl,
            },
          });
        }
        return user;
      }

      // Verificar se já existe um usuário com esse email (conta USER)
      const existingUser = await prismaWrite.user.findFirst({
        where: { 
          email: googleUser.email,
          accountType: 'USER',
        },
      });

      if (existingUser) {
        // Vincular conta Google a usuário existente
        user = await prismaWrite.user.update({
          where: { id: existingUser.id },
          data: {
            googleId: googleUser.googleId,
            googleEmail: googleUser.email,
            avatarUrl: googleUser.avatarUrl || existingUser.avatarUrl,
          },
        });
        return user;
      }

      // Criar novo usuário (sempre conta USER)
      // Gerar senha aleatória (usuários do Google não precisam de senha, mas o campo é obrigatório)
      const randomPassword = crypto.randomBytes(32).toString('hex');
      const hashedPassword = await bcrypt.hash(randomPassword, 10);

      user = await prismaWrite.user.create({
        data: {
          email: googleUser.email,
          accountType: 'USER', // Google login sempre cria conta USER
          password: hashedPassword, // Senha aleatória, usuário não poderá fazer login tradicional
          firstName: googleUser.firstName || 'Usuário',
          lastName: googleUser.lastName || 'Google',
          googleId: googleUser.googleId,
          googleEmail: googleUser.email,
          avatarUrl: googleUser.avatarUrl,
          acceptedTerms: true, // Assumindo que ao fazer login com Google, aceita os termos
          acceptedPrivacyPolicy: true,
        },
      });

      return user;
    } catch (error) {
      console.error('Error validating Google user:', error);
      throw new BadRequestException('Falha ao autenticar com o Google');
    }
  }

  /**
   * Gera um código temporário para trocar por tokens (mais seguro que passar tokens na URL)
   */
  async generateAuthCode(loginResult: any): Promise<string> {
    const code = crypto.randomBytes(32).toString('hex');
    // Armazenar tokens no cache por 5 minutos
    await this.cacheManager.set(`auth_code:${code}`, loginResult, 5 * 60 * 1000);
    return code;
  }

  /**
   * Troca código temporário por tokens
   */
  async exchangeCodeForTokens(code: string): Promise<any> {
    if (!code) {
      throw new BadRequestException('Código de autorização é obrigatório');
    }

    // Verificar se o código tem formato válido (deve ser hex de 64 caracteres)
    // O código do Google tem formato diferente (ex: "4/0ATX87l..."), então detectamos isso
    if (code.includes('/') || code.length < 60) {
      throw new BadRequestException(
        'Invalid authorization code format. This appears to be a Google OAuth code. ' +
        'Please use the temporary code provided by the callback redirect. ' +
        'The Google code is already processed by the backend.'
      );
    }

    if (code.length !== 64 || !/^[a-f0-9]+$/i.test(code)) {
      throw new BadRequestException(
        'Invalid authorization code format. Expected a 64-character hexadecimal string. ' +
        `Received: ${code.substring(0, 20)}... (length: ${code.length})`
      );
    }

    const cached = await this.cacheManager.get(`auth_code:${code}`);
    
    if (!cached) {
      throw new BadRequestException(
        'Invalid or expired authorization code. The code may have already been used or expired. ' +
        'Please try logging in again.'
      );
    }

    // Remover código do cache (uso único)
    await this.cacheManager.del(`auth_code:${code}`);

    return cached;
  }

  /**
   * Valida código do Google OAuth diretamente (sem Passport)
   * Recebe código do frontend e valida com Google
   */
  async validateGoogleCode(code: string, redirectUri: string): Promise<any> {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      throw new BadRequestException('Google OAuth não configurado');
    }

    try {
      // Trocar código por tokens do Google
      const tokenResponse = await firstValueFrom(
        this.httpService.post('https://oauth2.googleapis.com/token', {
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      );

      const { access_token, id_token } = tokenResponse.data;

      if (!access_token) {
        throw new BadRequestException('Falha ao trocar código Google por tokens');
      }

      // Obter dados do usuário usando o access_token
      const userInfoResponse = await firstValueFrom(
        this.httpService.get('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: {
            Authorization: `Bearer ${access_token}`,
          },
        }),
      );

      const googleUser = userInfoResponse.data;

      // Validar ou criar usuário
      const user = await this.validateGoogleUser({
        googleId: googleUser.id,
        email: googleUser.email,
        firstName: googleUser.given_name || '',
        lastName: googleUser.family_name || '',
        avatarUrl: googleUser.picture || null,
        accessToken: access_token,
      });

      // Fazer login e retornar tokens JWT
      return await this.login(user);
    } catch (error: any) {
      console.error('Error validating Google code:', error.response?.data || error.message);
      throw new BadRequestException(
        error.response?.data?.error_description ||
        'Failed to validate Google authorization code'
      );
    }
  }

  // ──────────────── 2FA por e-mail ────────────────

  private static readonly MFA_MAX_ATTEMPTS = 5;
  private static readonly MFA_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutos
  private static readonly MFA_RATE_TTL_MS = 60 * 1000;       // 1 minuto entre envios

  /**
   * Gera código de 6 dígitos, armazena no cache e envia por e-mail.
   * Rate limit: 1 envio por minuto por usuário.
   * O rate limit só é aplicado após envio bem-sucedido para não bloquear
   * o usuário em caso de falha no envio do e-mail.
   */
  async send2FACode(
    userId: string,
    userEmail: string,
    opts?: { userAgent?: string },
  ): Promise<void> {
    const rateLimitKey = `2fa_rate:${userId}`;
    if (await this.cacheManager.get(rateLimitKey)) {
      throw new BadRequestException('Aguarde 1 minuto antes de solicitar um novo código.');
    }

    // randomInt(min, max) → min <= n < max; usa 1_000_000 para incluir 999999
    const code = String(crypto.randomInt(100000, 1000000));
    const cacheKey = `2fa_code:${userId}`;
    const attemptsKey = `2fa_attempts:${userId}`;

    // Formata data/hora do Brasil (UTC-3, sem horário de verão desde 2019)
    const loginDate = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date()).replace(',', ' às');

    const loginDevice = this.parseDevice(opts?.userAgent);

    // Armazena código e zera tentativas antes de enviar
    await this.cacheManager.set(cacheKey, code, AuthService.MFA_CODE_TTL_MS);
    await this.cacheManager.del(attemptsKey);

    // Tenta enviar; desfaz o código armazenado se o e-mail falhar
    try {
      await this.emailService.send2FACode(userEmail, code, { loginDate, loginDevice });
    } catch (emailError) {
      await this.cacheManager.del(cacheKey);
      this.logger.error(`Falha ao enviar código 2FA para usuário ${userId}:`, emailError);
      throw new BadRequestException('Falha ao enviar o e-mail. Tente novamente.');
    }

    // Rate limit aplicado SOMENTE após envio bem-sucedido
    await this.cacheManager.set(rateLimitKey, true, AuthService.MFA_RATE_TTL_MS);
    this.logger.log(`Código 2FA enviado para usuário ${userId}`);
  }

  /**
   * Verifica o código e habilita o 2FA para o usuário.
   * Após 5 tentativas incorretas o código é invalidado.
   */
  async enable2FA(userId: string, code: string): Promise<void> {
    await this.verifyAndConsume2FACode(userId, code);

    const prismaWrite = this.prisma.getWriteClient();
    await prismaWrite.user.update({
      where: { id: userId },
      data: { mfaEnabled: true },
    });

    this.logger.log(`2FA habilitado para usuário ${userId}`);
  }

  /**
   * Verifica o código e desabilita o 2FA para o usuário.
   * Após 5 tentativas incorretas o código é invalidado.
   */
  async disable2FA(userId: string, code: string): Promise<void> {
    await this.verifyAndConsume2FACode(userId, code);

    const prismaWrite = this.prisma.getWriteClient();
    await prismaWrite.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, totpSecret: null },
    });

    this.logger.log(`2FA desabilitado para usuário ${userId}`);
  }

  /**
   * Verifica o código 2FA de forma segura (tempo constante) e o invalida após uso.
   * Limita a 5 tentativas incorretas; invalida o código ao atingir o limite.
   */
  private async verifyAndConsume2FACode(userId: string, code: string): Promise<void> {
    const cacheKey = `2fa_code:${userId}`;
    const attemptsKey = `2fa_attempts:${userId}`;

    const stored = await this.cacheManager.get<string>(cacheKey);

    if (!stored) {
      throw new BadRequestException('Código incorreto ou expirado.');
    }

    // Verifica limite de tentativas antes de comparar
    const attempts = (await this.cacheManager.get<number>(attemptsKey)) || 0;
    if (attempts >= AuthService.MFA_MAX_ATTEMPTS) {
      await this.cacheManager.del(cacheKey);
      this.logger.warn(`Código 2FA invalidado por excesso de tentativas — usuário ${userId}`);
      throw new BadRequestException('Muitas tentativas incorretas. Solicite um novo código.');
    }

    // Comparação em tempo constante para evitar timing attacks
    const isValid =
      stored.length === code.length &&
      crypto.timingSafeEqual(Buffer.from(stored, 'utf8'), Buffer.from(code, 'utf8'));

    if (!isValid) {
      const newAttempts = attempts + 1;
      await this.cacheManager.set(attemptsKey, newAttempts, AuthService.MFA_CODE_TTL_MS);
      if (newAttempts >= AuthService.MFA_MAX_ATTEMPTS) {
        await this.cacheManager.del(cacheKey);
        this.logger.warn(`Código 2FA invalidado por excesso de tentativas — usuário ${userId}`);
      } else {
        this.logger.warn(`Tentativa incorreta de código 2FA (${newAttempts}/${AuthService.MFA_MAX_ATTEMPTS}) — usuário ${userId}`);
      }
      throw new BadRequestException('Código incorreto ou expirado.');
    }

    // Código válido: consome (impede reuso)
    await this.cacheManager.del(cacheKey);
    await this.cacheManager.del(attemptsKey);
  }
}
