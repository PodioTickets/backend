import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    private configService: ConfigService,
    private authService: AuthService,
  ) {
    // Callback URL aponta para o BACKEND (GET /api/v1/auth/google/callback). O backend
    // recebe o `code` + `state`, extrai o `redirect_to` saneado do state e redireciona
    // para o frontend ({FRONTEND}/auth/callback?code=...&redirect_to=...). O front então
    // troca o code por tokens via POST /api/v1/auth/google/validate (redirectUri = este
    // mesmo callback do backend — o redirect_uri da troca precisa bater com o do consent).
    // Este `callbackURL` vira o `redirect_uri` da URL de consent → DEVE estar autorizado
    // no Google Cloud Console.
    const callbackUrl = configService.get<string>('GOOGLE_CALLBACK_URL');
    const port = configService.get<string>('PORT') || '3333';

    // Se GOOGLE_CALLBACK_URL estiver setado, usa como está; senão, default local p/ o backend.
    const finalCallbackUrl =
      callbackUrl || `http://localhost:${port}/api/v1/auth/google/callback`;

    super({
      clientID: configService.get<string>('GOOGLE_CLIENT_ID'),
      clientSecret: configService.get<string>('GOOGLE_CLIENT_SECRET'),
      callbackURL: finalCallbackUrl,
      scope: ['email', 'profile'],
    });
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ): Promise<any> {
    const { id, name, emails, photos } = profile;
    
    const user = {
      googleId: id,
      email: emails[0].value,
      firstName: name.givenName || '',
      lastName: name.familyName || '',
      avatarUrl: photos?.[0]?.value || null,
      accessToken,
    };

    done(null, user);
  }
}

