import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get('JWT_SECRET'),
      passReqToCallback: false,
    });
  }

  async validate(payload: any) {
    // Buscar usuário com accountType do payload ou buscar por ID
    const accountType = payload.accountType || 'USER';
    
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        documentNumber: true,
        role: true,
        accountType: true,
        isActive: true,
        phone: true,
        reservePhone: true,
        dateOfBirth: true,
        gender: true,
        genderDetails: true,
        language: true,
        avatarUrl: true,
        mfaEnabled: true,
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found or inactive');
    }

    // Verificar se o accountType do token corresponde ao do banco
    if (user.accountType !== accountType) {
      throw new UnauthorizedException('Invalid account type');
    }

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      documentNumber: user.documentNumber,
      role: user.role,
      accountType: user.accountType,
      phone: user.phone,
      emergencyPhone: user.reservePhone, // Alias para compatibilidade
      reservePhone: user.reservePhone,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      genderDetails: user.genderDetails,
      language: user.language,
      avatarUrl: user.avatarUrl,
      mfaEnabled: user.mfaEnabled,
    };
  }
}
