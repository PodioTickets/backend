/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: a checagem de "de onde veio o pedido" — uma proteção que, em ações que
 *           alteram dados (criar/editar/excluir), exige que o pedido tenha vindo do
 *           site oficial, não de um site estranho.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Pedidos de leitura (GET) passam sempre.
 *    • Pedidos que alteram dados só passam se a origem for o site permitido.
 *    • Quando não há origem, mas há "referer" válido, usa o referer.
 *    • Origem desconhecida em ação que altera dados → bloqueado.
 *
 *  COMO CONFERIMOS:
 *    Montamos pedidos de mentira (método + origem) e conferimos se libera ou bloqueia. Sem banco.
 * ============================================================================
 */
import { ForbiddenException } from '@nestjs/common';
import { RequestOriginGuard } from '../request-origin.guard';

const guard = new RequestOriginGuard();
const ctxFor = (method: string, headers: any): any => ({
  switchToHttp: () => ({ getRequest: () => ({ method, headers }) }),
});

describe('RequestOriginGuard', () => {
  it('GET passa sempre (não checa origem)', () => {
    expect(guard.canActivate(ctxFor('GET', {}))).toBe(true);
  });

  it('POST com origem permitida passa', () => {
    expect(guard.canActivate(ctxFor('POST', { origin: 'http://localhost:3000' }))).toBe(true);
  });

  it('POST usando o referer quando não há origin', () => {
    expect(guard.canActivate(ctxFor('PUT', { referer: 'http://localhost:3000/checkout' }))).toBe(true);
  });

  it('POST com origem desconhecida é bloqueado', () => {
    expect(() => guard.canActivate(ctxFor('POST', { origin: 'http://site-malicioso.com' }))).toThrow(
      ForbiddenException,
    );
  });

  it('POST sem origem nem referer é bloqueado', () => {
    expect(() => guard.canActivate(ctxFor('DELETE', {}))).toThrow(ForbiddenException);
  });
});
