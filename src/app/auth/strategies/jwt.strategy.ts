import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { CacheRedisService } from '../../../common/services/cache-redis.service';
import { resolveAuthSurface, accessCookieName } from '../auth-cookies.util';

/**
 * Extrai o JWT do cookie httpOnly da SUPERFÍCIE da request (admin/organizer/
 * client), resolvida pelo header `x-pt-surface`. Cada superfície tem seu cookie
 * (`pt_at_<surface>`) → sessões isoladas no mesmo navegador. cookie-parser
 * popula `req.cookies`.
 */
function cookieTokenExtractor(req: Request): string | null {
  const surface = resolveAuthSurface(req);
  const token = (req?.cookies as Record<string, string> | undefined)?.[
    accessCookieName(surface)
  ];
  return token && token !== 'undefined' && token !== 'null' ? token : null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private cache: CacheRedisService,
  ) {
    super({
      // Cookie primeiro; header Bearer como fallback (SSR helpers do front e
      // clientes legados durante a transição continuam funcionando).
      jwtFromRequest: ExtractJwt.fromExtractors([
        cookieTokenExtractor,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get('JWT_SECRET'),
      // Fixa o algoritmo de verificação. Sem isto, o passport-jwt aceita qualquer
      // alg da família suportada pelo jsonwebtoken — fechamos a janela de confusão
      // de algoritmo (ex.: token forjado pedindo outro alg). Usamos HMAC simétrico.
      algorithms: ['HS256'],
      passReqToCallback: false,
    });
  }

  async validate(payload: any) {
    // Token emitido no meio do fluxo de MFA (mfaPending=true) não dá acesso
    // a rotas protegidas — é apenas um challenge temporário para o endpoint
    // POST /auth/2fa/verify-login, que o verifica no body, fora do JwtStrategy.
    if (payload.mfaPending) {
      throw new UnauthorizedException('MFA não concluído');
    }

    // Buscar usuário com accountType do payload ou buscar por ID
    const accountType = payload.accountType || 'USER';
    
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        documentType: true,
        documentNumber: true,
        role: true,
        accountType: true,
        isActive: true,
        phone: true,
        reservePhone: true,
        dateOfBirth: true,
        gender: true,
        genderDetails: true,
        country: true,
        state: true,
        city: true,
        postalCode: true,
        street: true,
        number: true,
        complement: true,
        neighborhood: true,
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
      documentType: user.documentType,
      documentNumber: user.documentNumber,
      role: user.role,
      accountType: user.accountType,
      phone: user.phone,
      emergencyPhone: user.reservePhone, // Alias para compatibilidade
      reservePhone: user.reservePhone,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      genderDetails: user.genderDetails,
      country: user.country,
      state: user.state,
      city: user.city,
      postalCode: user.postalCode,
      street: user.street,
      number: user.number,
      complement: user.complement,
      neighborhood: user.neighborhood,
      language: user.language,
      avatarUrl: user.avatarUrl,
      mfaEnabled: user.mfaEnabled,
    };
  }
}
