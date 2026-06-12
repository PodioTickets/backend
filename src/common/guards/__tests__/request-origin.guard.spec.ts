/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: defesa CSRF stateless — em ações que ALTERAM dados (POST/PUT/PATCH/
 *           DELETE), bloqueia o pedido quando o navegador declara uma ORIGEM
 *           estrangeira (site que não é o nosso). Pedidos SEM origem (server-to-
 *           server, webhook, app nativo) são liberados — não são CSRF.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR:
 *    • Leitura (GET) passa sempre.
 *    • Mutação com origem do site oficial → passa.
 *    • Mutação usando o referer quando não há origin → passa se for do site.
 *    • Mutação com origem ESTRANHA → bloqueada (provável CSRF).
 *    • Mutação SEM origem nem referer → LIBERADA (não é navegador → não é CSRF).
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

  it('PUT usando o referer quando não há origin', () => {
    expect(guard.canActivate(ctxFor('PUT', { referer: 'http://localhost:3000/checkout' }))).toBe(true);
  });

  it('POST com origem desconhecida é bloqueado', () => {
    expect(() => guard.canActivate(ctxFor('POST', { origin: 'http://site-malicioso.com' }))).toThrow(
      ForbiddenException,
    );
  });

  it('mutação SEM origem nem referer é LIBERADA (server-to-server/webhook, não é CSRF)', () => {
    expect(guard.canActivate(ctxFor('DELETE', {}))).toBe(true);
  });

  it('referer de site estranho é bloqueado', () => {
    expect(() => guard.canActivate(ctxFor('POST', { referer: 'http://site-malicioso.com/x' }))).toThrow(
      ForbiddenException,
    );
  });
});
