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
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        documentNumber: true,
        role: true,
        isActive: true,
        phone: true,
        reservePhone: true,
        dateOfBirth: true,
        sex: true,
        gender: true,
        language: true,
        avatarUrl: true,
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found or inactive');
    }

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      documentNumber: user.documentNumber,
      role: user.role,
      phone: user.phone,
      emergencyPhone: user.reservePhone, // Alias para compatibilidade
      reservePhone: user.reservePhone,
      dateOfBirth: user.dateOfBirth,
      sex: user.sex,
      gender: user.gender,
      language: user.language,
      avatarUrl: user.avatarUrl,
    };
  }
}
