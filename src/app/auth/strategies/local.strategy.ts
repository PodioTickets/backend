import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth.service';
import { AccountType } from '@prisma/client';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: AuthService) {
    super({
      usernameField: 'emailOrCpf',
      passwordField: 'password',
      passReqToCallback: true, // Permite acessar o request completo
    });
  }

  async validate(req: any, emailOrCpf: string, password: string): Promise<any> {
    if (!emailOrCpf || typeof emailOrCpf !== 'string') {
      throw new UnauthorizedException('Email or CPF is required');
    }

    if (!password || typeof password !== 'string') {
      throw new UnauthorizedException('Senha é obrigatória');
    }

    // Obter accountType do body (default: USER)
    const accountType = (req.body?.accountType as AccountType) || AccountType.USER;

    const user = await this.authService.validateUser(emailOrCpf, password, accountType);
    if (!user) {
      throw new UnauthorizedException('Credenciais inválidas');
    }
    return user;
  }
}