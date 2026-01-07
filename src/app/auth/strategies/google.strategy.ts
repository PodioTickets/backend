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
    // Callback URL deve apontar para o frontend, não para o backend
    // O frontend recebe o código e faz POST para /api/v1/auth/google/validate
    const frontendUrl = configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    const callbackUrl = configService.get<string>('GOOGLE_CALLBACK_URL');
    
    let finalCallbackUrl: string;
    
    if (callbackUrl) {
      // Se já for uma URL completa, usar como está
      finalCallbackUrl = callbackUrl;
    } else {
      // Usar URL do frontend + /auth/callback
      finalCallbackUrl = `${frontendUrl}/auth/callback`;
    }
    
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

