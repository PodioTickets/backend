/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: a "chave de cache" — quando o cache de resposta está ligado, decide se uma
 *           rota pode ser guardada em cache e sob qual identificador. (Hoje o cache de
 *           resposta está desligado no app, mas a regra de chave segue testada.)
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Rota marcada como "não cachear" (@NoCache) → não gera chave (não guarda em cache).
 *    • Quando há usuário logado, a chave inclui o id dele (cache por usuário, não vaza entre contas).
 *    • Sem usuário, usa a chave base normal.
 *
 *  COMO CONFERIMOS:
 *    Trocamos a parte interna do cache por uma de mentira e conferimos a chave gerada. Sem banco.
 * ============================================================================
 */
import { CacheInterceptor } from '@nestjs/cache-manager';
import { HttpCacheInterceptor } from '../http-cache.interceptor';

const ctxFor = (user?: any): any => ({
  getHandler: () => () => undefined,
  switchToHttp: () => ({ getRequest: () => ({ user }) }),
});

describe('HttpCacheInterceptor.trackBy', () => {
  let reflector: { get: jest.Mock };
  let interceptor: HttpCacheInterceptor;
  let superTrackBy: jest.SpyInstance;

  beforeEach(() => {
    reflector = { get: jest.fn().mockReturnValue(false) };
    interceptor = new HttpCacheInterceptor({} as any, reflector as any);
    // a chave base vem do CacheInterceptor do Nest — fixamos para focar na nossa regra
    superTrackBy = jest.spyOn(CacheInterceptor.prototype as any, 'trackBy').mockReturnValue('/rota');
  });

  afterEach(() => superTrackBy.mockRestore());

  it('rota marcada como @NoCache não gera chave', () => {
    reflector.get.mockReturnValue(true); // NO_CACHE presente
    expect((interceptor as any).trackBy(ctxFor())).toBeUndefined();
  });

  it('com usuário logado, a chave inclui o id do usuário', () => {
    expect((interceptor as any).trackBy(ctxFor({ id: 'user-1' }))).toBe('/rota::auth:user-1');
  });

  it('sem usuário, usa a chave base', () => {
    expect((interceptor as any).trackBy(ctxFor())).toBe('/rota');
  });

  it('se a chave base é indefinida (rota não-cacheável), não gera chave', () => {
    superTrackBy.mockReturnValue(undefined);
    expect((interceptor as any).trackBy(ctxFor({ id: 'user-1' }))).toBeUndefined();
  });
});
