import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  // Sobrescrever para garantir que apenas a estratégia Google seja usada
  // e não tente usar a estratégia padrão (JWT)
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const result = (await super.canActivate(context)) as boolean;
      return result;
    } catch (error) {
      // Se falhar, relançar o erro
      throw error;
    }
  }

  handleRequest(err: any, user: any, info: any) {
    // Se houver erro ou não houver usuário, lançar exceção
    if (err) {
      throw err;
    }
    if (!user) {
      throw new Error('Google authentication failed');
    }
    return user;
  }
}

