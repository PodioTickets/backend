import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: AuthService) {
    super({
      usernameField: 'emailOrCpf', // Aceitar email ou CPF
      passwordField: 'password',
    });
  }

  async validate(emailOrCpf: string, password: string): Promise<any> {
    if (!emailOrCpf || typeof emailOrCpf !== 'string') {
      throw new UnauthorizedException('Email or CPF is required');
    }
    
    if (!password || typeof password !== 'string') {
      throw new UnauthorizedException('Password is required');
    }

    try {
      const user = await this.authService.validateUser(emailOrCpf, password);
      if (!user) {
        throw new UnauthorizedException('Invalid credentials');
      }
      return user;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Authentication failed');
    }
  }
} 