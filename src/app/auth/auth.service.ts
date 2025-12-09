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
import {
  EmailLoginDto,
  EmailRegisterDto,
  RefreshTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
} from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Valida usuário por email ou CPF
   */
  async validateUser(emailOrCpf: string, password: string): Promise<any> {
    if (!emailOrCpf || typeof emailOrCpf !== 'string') {
      return null;
    }

    if (!password || typeof password !== 'string') {
      return null;
    }

    try {
      // Tentar buscar por email ou CPF
      const isEmail = emailOrCpf.includes('@');
      let user;

      const prismaWrite = this.prisma.getWriteClient();

      if (isEmail) {
        user = await prismaWrite.user.findUnique({
          where: { email: emailOrCpf },
          select: {
            id: true,
            email: true,
            password: true,
            isActive: true,
            firstName: true,
            lastName: true,
            documentNumber: true,
            role: true,
          },
        });
      } else {
        // Buscar por CPF/documentNumber
        user = await prismaWrite.user.findUnique({
          where: { documentNumber: emailOrCpf },
          select: {
            id: true,
            email: true,
            password: true,
            isActive: true,
            firstName: true,
            lastName: true,
            documentNumber: true,
            role: true,
          },
        });
      }

      if (!user || !user.isActive) {
        return null;
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
      return null;
    }
  }

  async checkUserExists(emailOrCpf: string): Promise<boolean> {
    try {
      const isEmail = emailOrCpf.includes('@');
      const prismaRead = this.prisma.getReadClient();

      if (isEmail) {
        const user = await prismaRead.user.findUnique({
          where: { email: emailOrCpf },
          select: { id: true, isActive: true },
        });
        return user !== null && user.isActive;
      } else {
        const user = await prismaRead.user.findUnique({
          where: { documentNumber: emailOrCpf },
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

      // Verificar se email já existe
      const prismaWrite = this.prisma.getWriteClient();
      const prismaRead = this.prisma.getReadClient();

      const existingUserByEmail = await prismaRead.user.findUnique({
        where: { email },
      });

      if (existingUserByEmail) {
        throw new ConflictException('User with this email already exists');
      }

      // Verificar se CPF já existe (se fornecido)
      if (documentNumber) {
        const existingUserByCpf = await prismaRead.user.findUnique({
          where: { documentNumber },
        });

        if (existingUserByCpf) {
          throw new ConflictException(
            'User with this document number already exists',
          );
        }
      }

      const hashedPassword = await bcrypt.hash(password, 12);

      const user = await prismaWrite.user.create({
        data: {
          email,
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
          sex,
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

  async login(user: any) {
    const payload = { email: user.email, sub: user.id };
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
        },
      });

      if (!user || !user.isActive) {
        throw new UnauthorizedException('User not found or inactive');
      }

      const payload = { email: user.email, sub: user.id };
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

  async forgotPassword(forgotPasswordDto: ForgotPasswordDto) {
    const { email } = forgotPasswordDto;
    const prismaRead = this.prisma.getReadClient();

    const user = await prismaRead.user.findUnique({
      where: { email },
    });

    if (!user) {
      // Por segurança, não revelar se o email existe
      return {
        message:
          'If an account exists with this email, a password reset link has been sent',
      };
    }

    // Gerar token de reset
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hora

    // TODO: Salvar token no banco ou enviar por email
    // Por enquanto, apenas retornar sucesso

    return {
      message:
        'If an account exists with this email, a password reset link has been sent',
    };
  }

  async resetPassword(resetPasswordDto: ResetPasswordDto) {
    const { token, password } = resetPasswordDto;

    // TODO: Validar token e buscar usuário
    // Por enquanto, implementação básica

    if (password.length < 8) {
      throw new BadRequestException(
        'Password must be at least 8 characters long',
      );
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // TODO: Atualizar senha do usuário associado ao token
    // Por enquanto, apenas retornar sucesso

    return {
      message: 'Password reset successfully',
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
}
