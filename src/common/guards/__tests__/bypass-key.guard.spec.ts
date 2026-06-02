/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: a "chave mestra" de API — uma senha secreta no cabeçalho que libera
 *           certas rotas internas (integrações), pulando o login normal.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Com a chave certa no cabeçalho, libera o acesso.
 *    • Com chave errada ou ausente, bloqueia (não autorizado).
 *
 *  COMO CONFERIMOS:
 *    Montamos um pedido de mentira com/sem a chave e conferimos se libera ou bloqueia.
 *    Conta pura — sem banco nem internet.
 * ============================================================================
 */
import { UnauthorizedException } from '@nestjs/common';
import { BypassKeyGuard } from '../bypass-key.guard';

const ctxFor = (headers: any): any => ({
  switchToHttp: () => ({ getRequest: () => ({ headers }) }),
});

describe('BypassKeyGuard', () => {
  const config: any = { get: (k: string) => (k === 'API_BYPASS_SECRET' ? 'segredo-123' : undefined) };
  const guard = new BypassKeyGuard(config);

  it('libera quando a chave do cabeçalho bate com o segredo', () => {
    expect(guard.canActivate(ctxFor({ 'x-api-bypass': 'segredo-123' }))).toBe(true);
  });

  it('bloqueia com chave errada', () => {
    expect(() => guard.canActivate(ctxFor({ 'x-api-bypass': 'errada' }))).toThrow(UnauthorizedException);
  });

  it('bloqueia quando não há chave', () => {
    expect(() => guard.canActivate(ctxFor({}))).toThrow(UnauthorizedException);
  });
});
