import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { CacheRedisService } from '../../../common/services/cache-redis.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private cache: CacheRedisService,
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
      throw new UnauthorizedException('Usuário não encontrado ou inativo');
    }

    // Verificar se o accountType do token corresponde ao do banco
    if (user.accountType !== accountType) {
      throw new UnauthorizedException('Tipo de conta inválido');
    }

    // Organizadores precisam ter ao menos uma organização ativa
    if (accountType === 'ORGANIZER') {
      const cacheKey = `organizer_active:${payload.sub}`;
      let hasActiveOrg = await this.cache.getJson<boolean>(cacheKey);
      if (hasActiveOrg === null) {
        const row = await this.prisma.organizationMember.findFirst({
          where: { userId: payload.sub, organization: { isActive: true } },
          select: { id: true },
        });
        hasActiveOrg = !!row;
        await this.cache.setJson(cacheKey, hasActiveOrg, 300);
      }
      if (!hasActiveOrg) {
        throw new UnauthorizedException('Organization is inactive');
      }
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
