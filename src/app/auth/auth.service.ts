import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
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

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly httpService: HttpService,
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
          },
        });
      }

      if (!user || !user.isActive) {
        return null;
      }

      // Se for ORGANIZER, verificar se é membro de pelo menos uma organização
      if (accountType === 'ORGANIZER') {
        const member = await prismaRead.organizationMember.findFirst({
          where: {
            userId: user.id,
          },
        });

        if (!member) {
          // Usuário tem accountType ORGANIZER mas não é membro de nenhuma organização
          console.log(`[AUTH] User ${user.id} has accountType ORGANIZER but is not a member of any organization`);
          return null;
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
      console.error('[AUTH] Error validating user:', error);
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
        throw new ConflictException('User with this email already exists');
      }

      // Verificar se CPF já existe para conta USER (se fornecido)
      if (documentNumber) {
        const documentNumberClean = documentNumber.replace(/\D/g, '');
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
      const documentNumberClean = documentNumber ? documentNumber.replace(/\D/g, '') : null;

      const user = await prismaWrite.user.create({
        data: {
          email,
          accountType: 'USER', // Registro sempre cria conta de usuário normal
          password: hashedPassword,
          firstName: complete_name.split(' ')[0],
          lastName: complete_name.split(' ').slice(1).join(' '),
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

      return {
        message: 'User registered successfully',
        data: { user },
      };
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
          throw new ConflictException('User with this email already exists');
        }
        if (target?.includes('documentNumber')) {
          throw new ConflictException(
            'User with this document number already exists',
          );
        }
        throw new ConflictException('User already exists');
      }

      // Log do erro completo para debug
      console.error('Registration error:', error);
      throw new BadRequestException(error?.message || 'Failed to create user');
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

  async login(user: any) {
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

      const accessToken = this.jwtService.sign(payload);
      const refreshToken = await this.createRefreshToken(user.id);

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
        throw new UnauthorizedException('User not found or inactive');
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
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async logout(refreshToken: string) {
    // Implementar invalidação do refresh token se necessário
    // Por enquanto, apenas retornar sucesso
    return { message: 'Logged out successfully' };
  }

  async forgotPassword(forgotPasswordDto: ForgotPasswordDto, accountType: 'USER' | 'ORGANIZER' = 'USER') {
    const { email } = forgotPasswordDto;
    
    // Log inicial para debug
    console.log('\n========================================');
    console.log('📥 FORGOT PASSWORD REQUEST RECEIVED');
    console.log('========================================');
    console.log(`📧 Email recebido: ${email}`);
    console.log(`👤 Account Type: ${accountType}`);
    console.log('========================================\n');
    
    const prismaRead = this.prisma.getReadClient();

    // Buscar usuário considerando accountType
    const user = await prismaRead.user.findUnique({
      where: { 
        email_accountType: {
          email,
          accountType,
        }
      },
    });

    if (!user) {
      console.log(`❌ Usuário não encontrado para email: ${email} (${accountType})`);
      // Por segurança, não revelar se o email existe
      return {
        success: true,
        message: 'Se uma conta existir com este email, um código de recuperação foi enviado',
      };
    }
    
    console.log(`✅ Usuário encontrado: ${user.id} - ${user.firstName} ${user.lastName}`);

    // Gerar código de 6 dígitos
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    // Armazenar código no cache com chave única por email e accountType
    const cacheKey = `reset_code:${email}:${accountType}`;
    await this.cacheManager.set(cacheKey, {
      code,
      email,
      accountType,
      userId: user.id,
      expiresAt: expiresAt.toISOString(),
      attempts: 0,
      used: false,
    }, 15 * 60 * 1000); // 15 minutos

    // TODO: Enviar código por email
    // Log do código para desenvolvimento (remover em produção)
    const timestamp = new Date().toISOString();
    console.log('\n========================================');
    console.log('🔐 CÓDIGO DE RECUPERAÇÃO DE SENHA');
    console.log('========================================');
    console.log(`📧 Email: ${email}`);
    console.log(`👤 Tipo de Conta: ${accountType}`);
    console.log(`🔢 Código: ${code}`);
    console.log(`⏰ Expira em: ${expiresAt.toLocaleString('pt-BR')}`);
    console.log(`🕐 Gerado em: ${timestamp}`);
    console.log(`🔑 Cache Key: ${cacheKey}`);
    console.log('========================================\n');

    return {
      success: true,
      message: 'Se uma conta existir com este email, um código de recuperação foi enviado',
    };
  }

  async verifyResetCode(email: string, code: string, accountType: 'USER' | 'ORGANIZER' = 'USER') {
    const cacheKey = `reset_code:${email}:${accountType}`;
    
    // Log da tentativa de verificação
    console.log('\n========================================');
    console.log('🔍 TENTATIVA DE VERIFICAÇÃO DE CÓDIGO');
    console.log('========================================');
    console.log(`📧 Email: ${email}`);
    console.log(`👤 Tipo de Conta: ${accountType}`);
    console.log(`🔢 Código Recebido: ${code}`);
    console.log(`🔑 Cache Key: ${cacheKey}`);
    console.log('========================================\n');
    
    const cached = await this.cacheManager.get<any>(cacheKey);

    if (!cached) {
      console.log('❌ Código não encontrado no cache ou expirado');
      throw new BadRequestException('Código inválido ou expirado');
    }
    
    console.log(`✅ Código encontrado no cache. Código armazenado: ${cached.code}`);
    console.log(`📊 Tentativas anteriores: ${cached.attempts}`);
    console.log(`⏰ Expira em: ${new Date(cached.expiresAt).toLocaleString('pt-BR')}`);

    if (cached.used) {
      throw new BadRequestException('Código já foi utilizado');
    }

    if (new Date(cached.expiresAt) < new Date()) {
      throw new BadRequestException('Código expirado');
    }

    if (cached.attempts >= 5) {
      throw new BadRequestException('Muitas tentativas. Solicite um novo código');
    }

    // Incrementar tentativas
    cached.attempts += 1;
    await this.cacheManager.set(cacheKey, cached, 15 * 60 * 1000);

    if (cached.code !== code) {
      throw new BadRequestException('Código inválido');
    }

    // Marcar código como usado
    cached.used = true;
    await this.cacheManager.set(cacheKey, cached, 15 * 60 * 1000);

    // Gerar token JWT para reset de senha
    const resetToken = this.jwtService.sign(
      {
        email,
        accountType,
        userId: cached.userId,
        type: 'password_reset',
      },
      {
        expiresIn: '30m', // 30 minutos
      }
    );

    return {
      success: true,
      token: resetToken,
      message: 'Código verificado com sucesso',
    };
  }

  async resendResetCode(email: string, accountType: 'USER' | 'ORGANIZER' = 'USER') {
    const prismaRead = this.prisma.getReadClient();

    // Verificar se usuário existe
    const user = await prismaRead.user.findUnique({
      where: { 
        email_accountType: {
          email,
          accountType,
        }
      },
    });

    if (!user) {
      // Por segurança, não revelar se o email existe
      return {
        success: true,
        message: 'Se uma conta existir com este email, um código de recuperação foi enviado',
      };
    }

    // Verificar rate limit (máximo 1 reenvio por minuto)
    const rateLimitKey = `reset_code_rate_limit:${email}:${accountType}`;
    const rateLimit = await this.cacheManager.get(rateLimitKey);
    
    if (rateLimit) {
      throw new BadRequestException('Aguarde antes de solicitar um novo código');
    }

    // Definir rate limit de 1 minuto
    await this.cacheManager.set(rateLimitKey, true, 60 * 1000);

    // Gerar novo código
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    // Armazenar novo código
    const cacheKey = `reset_code:${email}:${accountType}`;
    await this.cacheManager.set(cacheKey, {
      code,
      email,
      accountType,
      userId: user.id,
      expiresAt: expiresAt.toISOString(),
      attempts: 0,
      used: false,
    }, 15 * 60 * 1000);

    // TODO: Enviar código por email
    // Log do código para desenvolvimento (remover em produção)
    const timestamp = new Date().toISOString();
    console.log('\n========================================');
    console.log('🔄 CÓDIGO DE RECUPERAÇÃO REENVIADO');
    console.log('========================================');
    console.log(`📧 Email: ${email}`);
    console.log(`👤 Tipo de Conta: ${accountType}`);
    console.log(`🔢 Novo Código: ${code}`);
    console.log(`⏰ Expira em: ${expiresAt.toLocaleString('pt-BR')}`);
    console.log(`🕐 Reenviado em: ${timestamp}`);
    console.log(`🔑 Cache Key: ${cacheKey}`);
    console.log('========================================\n');

    return {
      success: true,
      message: 'Código reenviado com sucesso',
    };
  }

  async resetPassword(resetPasswordDto: ResetPasswordDto) {
    const { token, password } = resetPasswordDto;

    if (password.length < 8) {
      throw new BadRequestException(
        'A senha deve ter no mínimo 8 caracteres',
      );
    }

    // Validar senha forte (pelo menos uma maiúscula, uma minúscula e um número)
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
    if (!passwordRegex.test(password)) {
      throw new BadRequestException(
        'A senha deve conter pelo menos uma letra maiúscula, uma minúscula e um número',
      );
    }

    let decoded: any;
    try {
      decoded = this.jwtService.verify(token);
    } catch (error) {
      throw new BadRequestException('Token inválido ou expirado');
    }

    if (decoded.type !== 'password_reset') {
      throw new BadRequestException('Token inválido');
    }

    const { email, accountType, userId } = decoded;

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Verificar se usuário ainda existe
    const user = await prismaRead.user.findUnique({
      where: { 
        email_accountType: {
          email,
          accountType,
        }
      },
    });

    if (!user || user.id !== userId) {
      throw new BadRequestException('Usuário não encontrado');
    }

    // Verificar se a nova senha não é igual à atual
    const isSamePassword = await bcrypt.compare(password, user.password);
    if (isSamePassword) {
      throw new BadRequestException('A nova senha não pode ser igual à senha atual');
    }

    // Criptografar nova senha
    const hashedPassword = await bcrypt.hash(password, 12);

    // Atualizar senha
    await prismaWrite.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });

    // Invalidar todos os códigos de reset pendentes para este email/accountType
    const cacheKey = `reset_code:${email}:${accountType}`;
    await this.cacheManager.del(cacheKey);

    return {
      success: true,
      message: 'Senha redefinida com sucesso',
    };
  }

  /**
   * Troca a senha do usuário logado. Se já tiver senha, exige currentPassword. Se não tiver (ex.: só Google), só newPassword.
   */
  async changePassword(userId: string, dto: ChangePasswordDto) {
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
      select: { id: true, password: true },
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
    await prismaWrite.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    return {
      success: true,
      message: 'Senha alterada com sucesso',
    };
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
      throw new BadRequestException('Failed to authenticate with Google');
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
      throw new BadRequestException('Authorization code is required');
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
      throw new BadRequestException('Google OAuth not configured');
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
        throw new BadRequestException('Failed to exchange Google code for tokens');
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
}
