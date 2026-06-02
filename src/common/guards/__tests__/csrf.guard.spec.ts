/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: a proteção CSRF — garante que um pedido que altera dados veio mesmo do
 *           nosso site, exigindo um "token de segurança" que combina com um segredo
 *           guardado num cookie do navegador.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Sem o cookie ou sem o token → bloqueado.
 *    • Token que não combina com o segredo → bloqueado.
 *    • Token válido (assinado com o segredo) → liberado.
 *
 *  COMO CONFERIMOS:
 *    Geramos um token válido de verdade (mesma assinatura HMAC que o sistema usa) e
 *    montamos pedidos de mentira. Conta pura — sem banco nem internet.
 * ============================================================================
 */
import { ForbiddenException } from '@nestjs/common';
import * as crypto from 'crypto';
import { CsrfGuard } from '../csrf.guard';

const guard = new CsrfGuard();
const ctxFor = (cookies: any, headers: any): any => ({
  switchToHttp: () => ({ getRequest: () => ({ cookies, headers }) }),
});

// Gera um token no MESMO formato do guard: "<timestamp>.<hmacSha256(secret, timestamp)>"
function makeToken(secret: string, timestamp = '1700000000000'): string {
  const sig = crypto.createHmac('sha256', secret).update(timestamp).digest('hex');
  return `${timestamp}.${sig}`;
}

describe('CsrfGuard', () => {
  const secret = 'segredo-csrf';

  it('libera com token válido (assinado com o segredo do cookie)', () => {
    const ctx = ctxFor({ csrf_secret: secret }, { 'x-csrf-token': makeToken(secret) });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('bloqueia sem o cookie de segredo', () => {
    const ctx = ctxFor({}, { 'x-csrf-token': makeToken(secret) });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('bloqueia sem o token no cabeçalho', () => {
    const ctx = ctxFor({ csrf_secret: secret }, {});
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('bloqueia token assinado com outro segredo', () => {
    const ctx = ctxFor({ csrf_secret: secret }, { 'x-csrf-token': makeToken('outro-segredo') });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
